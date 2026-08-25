/**
 * NAI 페이지 진입점.
 * - 항상 보이는 플로팅 패널 마운트
 * - 패널의 ▶ 자동으로 버튼 → runBatch
 * - popup/options 로부터의 메시지 (배치 시작/중단, Anlas 조회)
 */

import './overlay.css';
import { mountPanel, unmountPanel, getToast, pickGridImages } from './overlay';
import {
  runBatch,
  resumeBatch,
  stopBatch,
  pauseBatch,
  getRunState,
  wasSavedByRunner,
  parseAnlasCostFromGenerateButton,
} from './runner';
import {
  readAnlas,
  findMainImage,
  findGridImages,
  findSeedButton,
  setUcText,
  diagnoseResultImages,
  describeImageSearch,
  SEL,
} from './selectors';
import { blobUrlToBytes, bytesToBase64, pmSetText, setSeedValue } from './dom-helpers';
import { getSettings, renderFilename, type Settings } from '../lib/storage';
import { pickVisible } from './selectors';
import { parseNaiWebP, summarize } from '../lib/nai-metadata';
import { addHistoryEntry } from '../lib/history';
import { sendMessage, type NaisuMessage } from '../lib/messages';
import { cacheImage } from './image-cache';
import { MODE_LABEL } from './panel-popover';
import type { SaveOverride } from './panel-types';

mountPanel();
wireHandlers();

function wireHandlers(): void {
  const toast = getToast();
  toast.onStart((count) => void runBatch(count));
  toast.onPause(() => pauseBatch());
  toast.onStop(() => stopBatch());
  toast.onManualDownload(manualDownload);
  toast.onResume(() => void resumeBatch());
}

// ---------------------------------------------------------------------------
// 저장 파이프라인 (수동 저장 · 다시 저장이 공유)
//
// 자동 배치는 runner.ts가 자기 경로를 갖고 있다(파일명에 배치 번호/폴더가 들어가고,
// 이력·Discord·리포트까지 엮여 있어 합치면 오히려 갈라진다). 여기서는 "화면에 있는
// 이미지 한 장을 지금 저장한다"만 다룬다.
// ---------------------------------------------------------------------------

let resultSeq = 0;
function nextResultId(): string {
  return `r${Date.now().toString(36)}-${(resultSeq++).toString(36)}`;
}

interface SaveParams {
  settings: Settings;
  mode: Settings['downloadMode'];
  folder: string;
  filenameTemplate: string;
  imageOps: Settings['imageOps'];
}

/**
 * override(이번 한 번만 다르게)를 전역 설정 위에 얹어 실제 저장 파라미터를 만든다.
 * ⚠ override는 절대 저장되지 않는다 — "이번 한 장만"이 다음 장까지 따라가면 안 된다.
 */
async function resolveSaveParams(override?: SaveOverride): Promise<SaveParams> {
  const settings = await getSettings();
  return {
    settings,
    mode: override?.mode ?? settings.downloadMode,
    folder: settings.downloadFolder,
    filenameTemplate: settings.filenameTemplate,
    imageOps: settings.imageOps,
  };
}

/**
 * 바이트 한 장을 저장하고 로그에 결과를 남긴다.
 * 원본 바이트는 캐시에 넣어 둔다 — 하드클린이 조용히 실패했을 때 재저장할 수 있는
 * 유일한 복구 수단이고, 그건 원본을 들고 있어야만 가능하다.
 */
async function saveOneImage(
  bytes: Uint8Array,
  params: SaveParams,
  opts: { suffix?: string },
): Promise<void> {
  const toast = getToast();
  const s = summarize(parseNaiWebP(bytes));
  const filename =
    renderFilename(params.filenameTemplate, {
      seed: s.seed,
      model: s.model,
      w: s.width,
      h: s.height,
      steps: s.steps,
      sampler: s.sampler,
    }) + (opts.suffix ?? '');

  // 캐시는 저장 성패와 무관하게 먼저 넣는다 — 저장이 실패했을 때야말로 다시 저장이 필요하다.
  await cacheImage(
    {
      id: nextResultId(),
      bytes: bytes.slice().buffer,
      filename,
      seed: s.seed,
      model: s.model,
      prompt: s.prompt,
    },
    params.settings.cacheLimit,
  );

  try {
    const resp = await sendMessage('naisu.download', {
      bytes: bytesToBase64(bytes),
      mode: params.mode,
      folder: params.folder,
      filename,
      strip: { keepIccp: params.settings.keepColorProfile },
      conflictAction: params.settings.conflictAction,
      imageOps: params.imageOps,
    });

    const okCount = (resp.items ?? []).filter((i) => i.ok).length;
    const failed = (resp.items ?? []).filter((i) => !i.ok);
    const detailBits = [resp.opsNote, ...failed.map((f) => `${f.path}: ${f.error ?? '알 수 없는 오류'}`)].filter(Boolean);

    if (resp.error) {
      toast.log(`저장 실패 — ${resp.error}`, 'bad');
    } else if (okCount === 0) {
      const why = detailBits.join(' · ') || '알 수 없는 이유로 저장되지 않았습니다';
      toast.log(`저장 실패 — ${why}`, 'bad');
      toast.alert(`저장 실패 — ${why}`);
    } else {
      toast.log(`저장됨 · ${okCount}개${resp.opsNote ? ` (${resp.opsNote})` : ''}`, 'good');
    }

    if (resp.stripStatus) {
      toast.log(resp.stripStatus.message, resp.stripStatus.level);
      if (resp.stripStatus.detail) console.error('[naisu] stripStatus 상세:', resp.stripStatus.detail);
      if (resp.stripStatus.level === 'bad') toast.alert(resp.stripStatus.message);
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    toast.log(`저장 실패 — ${why}`, 'bad');
  }
}

// 수동 저장 버튼 → 현재 화면의 결과 이미지를 즉시 다운로드
// NAI는 Generate 한 번으로 1~4장을 그리드로 동시 생성할 수 있어서, 그리드 컨테이너를
// 찾을 수 있으면 그 안의 이미지를 전부 저장하고 — 못 찾으면(셀렉터 변경 등) 기존처럼
// 화면 중앙에 표시된 이미지 한 장만 저장하는 폴백으로 떨어진다.
async function manualDownload(override?: SaveOverride): Promise<void> {
  const toast = getToast();
  const grid = findGridImages();
  const main = findMainImage();
  const imgs = grid.length > 0 ? grid : main ? [main] : [];
  if (imgs.length === 0) {
    // "이미지 없음"만 말하면 사용자가 다음에 뭘 해야 할지 알 수 없다 — 진짜 없는 건지,
    // 아직 로딩 중인지, 화면 밖인지, NAI가 구조를 바꾼 건지에 따라 할 일이 다르다.
    const d = diagnoseResultImages();
    toast.log(d.message, 'bad');
    console.warn(`[naisu] 저장할 이미지를 찾지 못함 — ${describeImageSearch(d)}`);
    // 셀렉터가 깨진 경우는 사용자가 기다린다고 해결되지 않으므로 배너로 한 번 더 알린다
    if (d.totalOnPage > 0 && d.inContainer === 0) toast.alert(d.message);
    return;
  }

  // 그리드가 2장 이상이면 무엇을 저장할지 고르게 한다. 기본은 전부 선택이라
  // 그냥 Enter만 눌러도 예전과 같은 결과가 되고, 4장 중 2번만 원할 때 비로소 방법이 생긴다.
  // (자동 배치에는 붙이지 않는다 — 무인 실행 중에 사람이 고를 수 없다)
  let chosen = imgs.map((_, i) => i);
  if (imgs.length > 1) {
    const picked = await pickGridImages(
      imgs.map((img, i) => ({ src: img.src, label: `${i + 1}번 이미지` })),
    );
    if (picked === null) {
      toast.log('저장을 취소했습니다', 'info');
      return;
    }
    chosen = picked;
  }

  const params = await resolveSaveParams(override);
  if (override?.mode) {
    toast.log(`이번 저장만 ${MODE_LABEL[params.mode]}으로 진행합니다`, 'info');
  }

  for (const g of chosen) {
    const img = imgs[g]!;
    try {
      const bytes = await blobUrlToBytes(img.src);
      await saveOneImage(bytes, params, { suffix: imgs.length > 1 ? `_g${g + 1}` : '' });
    } catch (e) {
      toast.log(`저장 실패 ${g + 1}/${imgs.length} — ${e instanceof Error ? e.message : String(e)}`, 'bad');
    }
  }
}

async function fillSeed(seed: number): Promise<boolean> {
  const btn = findSeedButton();
  if (!btn) return false;
  return setSeedValue(btn, seed);
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
    case 'naisu.seed.fill': {
      const seed = msg.payload?.seed;
      if (typeof seed !== 'number') {
        sendResponse({ ok: false, reason: '시드 값이 없습니다' });
        return false;
      }
      void fillSeed(seed).then((ok) =>
        sendResponse({ ok, reason: ok ? undefined : '시드 입력란을 찾지 못했습니다' }),
      );
      return true; // async
    }
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
