/**
 * NAI 페이지 진입점.
 * - 항상 보이는 플로팅 패널 마운트
 * - 패널의 ▶ 자동으로 버튼 → runBatch
 * - popup/options 로부터의 메시지 (배치 시작/중단, Anlas 조회)
 */

import './overlay.css';
import { mountPanel, unmountPanel, getToast } from './overlay';
import {
  runBatch,
  resumeBatch,
  stopBatch,
  pauseBatch,
  getRunState,
  wasSavedByRunner,
  parseAnlasCostFromGenerateButton,
} from './runner';
import { readAnlas, findMainImage, findGridImages, setUcText, SEL } from './selectors';
import { blobUrlToBytes, bytesToBase64, pmSetText } from './dom-helpers';
import { getSettings, renderFilename } from '../lib/storage';
import { pickVisible } from './selectors';
import { parseNaiWebP, summarize } from '../lib/nai-metadata';
import { addHistoryEntry } from '../lib/history';
import { sendMessage, type NaisuMessage } from '../lib/messages';

mountPanel();
wireHandlers();

function wireHandlers(): void {
  const toast = getToast();
  toast.onStart((count) => void runBatch(count));
  toast.onPause(() => pauseBatch());
  toast.onStop(() => stopBatch());
  toast.onManualDownload(manualDownload);
}

// 수동 저장 버튼 → 현재 화면의 결과 이미지를 즉시 다운로드
// NAI는 Generate 한 번으로 1~4장을 그리드로 동시 생성할 수 있어서, 그리드 컨테이너를
// 찾을 수 있으면 그 안의 이미지를 전부 저장하고 — 못 찾으면(셀렉터 변경 등) 기존처럼
// 화면 중앙에 표시된 이미지 한 장만 저장하는 폴백으로 떨어진다.
async function manualDownload(): Promise<void> {
  const toast = getToast();
  const grid = findGridImages();
  const main = findMainImage();
  const imgs = grid.length > 0 ? grid : main ? [main] : [];
  if (imgs.length === 0) {
    toast.log('저장할 이미지 없음 — 먼저 NAI에서 이미지를 생성하세요', 'bad');
    return;
  }
  const isGrid = imgs.length > 1;
  if (isGrid) toast.log(`그리드 ${imgs.length}장 감지됨 — 전부 저장합니다`, 'info');

  const settings = await getSettings();
  for (let g = 0; g < imgs.length; g++) {
    const img = imgs[g];
    const label = isGrid ? `${g + 1}/${imgs.length}` : '';
    try {
      const bytes = await blobUrlToBytes(img.src);
      const meta = parseNaiWebP(bytes);
      const s = summarize(meta);
      const filename =
        renderFilename(settings.filenameTemplate, {
          seed: s.seed, model: s.model, w: s.width, h: s.height, steps: s.steps, sampler: s.sampler,
        }) + (isGrid ? `_g${g + 1}` : '');
      const resp = await sendMessage('naisu.download', {
        bytes: bytesToBase64(bytes),
        mode: settings.downloadMode,
        folder: settings.downloadFolder,
        filename,
        strip: { keepIccp: settings.keepColorProfile },
      });
      if (resp?.error) toast.log(`저장 실패 ${label} — ${resp.error}`, 'bad');
      else toast.log(`저장됨 ${label} · ${resp?.saved?.length ?? 0}개`, 'good');
      if (resp?.stripStatus) {
        toast.log(resp.stripStatus.message, resp.stripStatus.level);
        if (resp.stripStatus.detail) console.error('[naisu] stripStatus 상세:', resp.stripStatus.detail);
        if (resp.stripStatus.level === 'bad') toast.alert(resp.stripStatus.message);
      }
    } catch (e) {
      toast.log(`저장 실패 ${label} — ${e instanceof Error ? e.message : String(e)}`, 'bad');
    }
  }
}

console.log('[naisu] content script ready');

// ---- 이력 자동 저장 ----
const _historyKnownSrcs = new Set<string>();

/**
 * 이력 워처.
 *
 * P01: 예전엔 2초 폴링이 탭이 숨어 있어도 계속 돌면서 새 blob을 전부 fetch·파싱했다.
 * 배치를 걸어두고 다른 탭에서 작업하는 게 이 도구의 표준 사용법이라 그동안의 비용이 그대로 낭비였다.
 * 이제 MutationObserver가 주 신호이고, 폴링은 attribute mutation이 안 잡히는 경우를 위한
 * 낮은 빈도 백업으로만 남긴다. 탭이 숨겨지면 둘 다 멈춘다.
 *
 * B02: 러너가 이미 fetch·파싱한 이미지는 wasSavedByRunner()로 걸러 두 번 읽지 않는다.
 * 이 워처의 역할은 "사용자가 패널 없이 직접 생성한 이미지 줍기"만 남는다.
 */
const BACKUP_POLL_MS = 5000;

let watcherObserver: MutationObserver | null = null;
let watcherTimer: number | undefined;

/**
 * 첫 스캔은 "이미 화면에 있던 이미지"를 기록만 하고 저장하지 않는다.
 *
 * 확장이 붙는 시점에 NAI History 사이드바에는 이전 세션 이미지가 여러 장 떠 있다.
 * 예전에는 그것들을 전부 fetch + EXIF 파싱해서 이력에 넣었는데,
 *  ① 페이지 진입 직후 가장 바쁜 순간에 수 MB를 읽어 시작이 느려지고
 *  ② 지금 만든 것도 아닌 이미지가 "제작 이력"에 쌓였다.
 */
let historySeeded = false;

function scanForNewImages(): void {
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>(SEL.resultImage));
  for (const img of imgs) {
    if (!img.src.startsWith('blob:') || _historyKnownSrcs.has(img.src)) continue;
    if (!img.complete || img.naturalWidth < 256) continue;
    _historyKnownSrcs.add(img.src);
    if (!historySeeded) continue; // 진입 시점에 이미 있던 것 — 기록만 하고 넘어간다
    // 러너가 이미 같은 blob을 파싱해서 이력에 넣었으면 다시 읽지 않는다
    if (wasSavedByRunner(img.src)) continue;
    void saveImageToHistory(img.src);
  }
  if (!historySeeded) {
    historySeeded = true;
    console.log(`[naisu] 이력 워처 시작 — 기존 이미지 ${_historyKnownSrcs.size}장은 건너뜁니다`);
  }
  // 더 이상 DOM에 없는 blob URL 제거 (메모리 누수 방지)
  const liveSrcs = new Set(imgs.map((img) => img.src).filter((src) => src.startsWith('blob:')));
  for (const src of _historyKnownSrcs) {
    if (!liveSrcs.has(src)) _historyKnownSrcs.delete(src);
  }
}

function stopHistoryWatcher(): void {
  watcherObserver?.disconnect();
  watcherObserver = null;
  if (watcherTimer) clearInterval(watcherTimer);
  watcherTimer = undefined;
}

function startHistoryWatcher(): void {
  if (document.hidden || watcherObserver) return;
  watcherObserver = new MutationObserver(() => scanForNewImages());
  watcherObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
  watcherTimer = window.setInterval(scanForNewImages, BACKUP_POLL_MS);
  scanForNewImages();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopHistoryWatcher();
  else startHistoryWatcher();
});

async function saveImageToHistory(src: string): Promise<void> {
  try {
    const bytes = await blobUrlToBytes(src);
    const meta = parseNaiWebP(bytes);
    const s = summarize(meta);
    if (!s.prompt && !s.seed) return;
    const chars = s.characters
      .map((c) => (c?.char_caption ?? '').trim())
      .filter(Boolean);
    await addHistoryEntry({
      prompt: s.prompt ?? '',
      characters: chars.length > 0 ? chars : undefined,
      uc: s.uc,
      seed: s.seed,
      model: s.model,
      sampler: s.sampler,
      width: s.width,
      height: s.height,
      steps: s.steps,
      scale: s.scale,
    });
  } catch (e) {
    console.error('[naisu] history save failed', e);
  }
}

/**
 * U10: 이력에서 고른 프롬프트를 NAI 입력란에 채운다.
 * 실패를 조용히 삼키지 않고 사유를 그대로 돌려준다 — 팝업이 그 문자열을 사용자에게 보여준다.
 */
function fillPrompt(payload: { prompt: string; uc?: string } | undefined): { ok: boolean; reason?: string } {
  if (!payload?.prompt) return { ok: false, reason: '채울 프롬프트가 비어 있습니다' };
  const pm = pickVisible<HTMLElement>(SEL.mainPrompt);
  if (!pm) return { ok: false, reason: '프롬프트 입력 영역을 찾지 못했습니다 (NAI 화면이 맞는지 확인해 주세요)' };

  // ⚠ 순서가 안전망이다. execCommand는 "지금 포커스된" 편집기에 쓰기 때문에,
  //   숨은 UC 탭에 쓰려다 실패하면 그 내용이 메인 프롬프트로 새어 들어간다
  //   (2026-08-24 실측: 메인 프롬프트가 UC 내용으로 덮였다).
  //   UC를 먼저 시도하고 프롬프트를 마지막에 쓰면, 새어 들어간 내용은 곧바로 덮여 사라진다.
  let ucNote = '';
  if (payload.uc) {
    if (!setUcText(payload.uc)) {
      ucNote = ' 네거티브(UC)는 채우지 못했습니다 — Undesired Content 탭을 연 뒤 다시 시도해 주세요.';
    }
  }

  if (!pmSetText(pm, payload.prompt)) {
    return { ok: false, reason: '프롬프트 입력에 실패했습니다 — Prompt 탭이 열려 있는지 확인해 주세요' };
  }

  console.log('[naisu] 이력 프롬프트를 입력란에 채웠습니다');
  return ucNote ? { ok: true, reason: `프롬프트를 채웠습니다.${ucNote}` } : { ok: true };
}

chrome.runtime.onMessage.addListener((req: unknown, _sender, sendResponse) => {
  const msg = req as Partial<NaisuMessage>;
  switch (msg.type) {
    case 'naisu.query.anlas':
      sendResponse({
        anlas: readAnlas(),
        state: getRunState(),
        generateCost: parseAnlasCostFromGenerateButton(),
      });
      return false;
    case 'naisu.batch.start':
      void runBatch(msg.payload?.count);
      sendResponse({ ok: true });
      return false;
    case 'naisu.batch.stop':
      stopBatch();
      sendResponse({ ok: true });
      return false;
    case 'naisu.batch.pause':
      pauseBatch();
      sendResponse({ ok: true });
      return false;
    case 'naisu.manual.download':
      // 단축키(Alt+Shift+D)가 패널 버튼과 같은 동작을 타게 한다
      void manualDownload();
      sendResponse({ ok: true });
      return false;
    case 'naisu.batch.resume':
      void resumeBatch();
      sendResponse({ ok: true });
      return false;
    case 'naisu.prompt.fill':
      sendResponse(fillPrompt(msg.payload));
      return false;
    case 'naisu.ui.reset':
      unmountPanel();
      mountPanel(true);
      wireHandlers();
      sendResponse({ ok: true });
      return false;
    default:
      // 선언은 됐지만 아직 구현되지 않은 메시지(naisu.selfcheck 등)도 여기서 응답한다.
      // 응답 없이 return하면 호출한 쪽 Promise가 undefined로 조용히 끝나 원인 추적이 어렵다.
      sendResponse({ ok: false, reason: `처리되지 않은 메시지: ${String(msg.type)}` });
      return false;
  }
});

// 이력 워처는 파일 맨 끝에서 시작한다.
// (위쪽에서 호출하면 아래의 const _historyKnownSrcs / BACKUP_POLL_MS 가 아직 초기화되지 않아
//  "Cannot access 'X' before initialization" 으로 content script 전체가 죽는다 — 2026-08-23 실측)
startHistoryWatcher();
