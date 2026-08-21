/**
 * NAI 페이지 진입점.
 * - 항상 보이는 플로팅 패널 마운트
 * - 패널의 ▶ 자동으로 버튼 → runBatch
 * - popup/options 로부터의 메시지 (배치 시작/중단, Anlas 조회)
 */

import './overlay.css';
import { mountPanel, unmountPanel, getToast } from './overlay';
import { runBatch, stopBatch, pauseBatch, isRunning } from './runner';
import { readAnlas, findMainImage, findGridImages, SEL } from './selectors';
import { blobUrlToBytes, bytesToBase64 } from './dom-helpers';
import { getSettings, renderFilename } from '../lib/storage';
import { parseNaiWebP, summarize } from '../lib/nai-metadata';
import { addHistoryEntry } from '../lib/history';

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
      const resp = await chrome.runtime.sendMessage({
        type: 'naisu.download',
        payload: {
          bytes: bytesToBase64(bytes),
          mode: settings.downloadMode,
          folder: settings.downloadFolder,
          filename,
          strip: { keepIccp: settings.keepColorProfile },
        },
      });
      if (resp?.error) toast.log(`저장 실패 ${label} — ${resp.error}`, 'bad');
      else toast.log(`저장됨 ${label} · ${resp?.saved?.length ?? 0}개`, 'good');
      if (resp?.stripStatus) {
        toast.log(resp.stripStatus.message, resp.stripStatus.level);
        if (resp.stripStatus.level === 'bad') toast.alert(resp.stripStatus.message);
      }
    } catch (e) {
      toast.log(`저장 실패 ${label} — ${e instanceof Error ? e.message : String(e)}`, 'bad');
    }
  }
}

startHistoryWatcher();
console.log('[naisu] content script ready');

// ---- 이력 자동 저장 ----
const _historyKnownSrcs = new Set<string>();

function startHistoryWatcher(): void {
  setInterval(() => {
    document.querySelectorAll<HTMLImageElement>(SEL.resultImage).forEach((img) => {
      if (!img.src.startsWith('blob:') || _historyKnownSrcs.has(img.src)) return;
      if (!img.complete || img.naturalWidth < 256) return;
      _historyKnownSrcs.add(img.src);
      void saveImageToHistory(img.src);
    });
    // 더 이상 DOM에 없는 blob URL 제거 (메모리 누수 방지)
    const liveSrcs = new Set(
      Array.from(document.querySelectorAll<HTMLImageElement>(SEL.resultImage))
        .map((img) => img.src)
        .filter((s) => s.startsWith('blob:')),
    );
    for (const src of _historyKnownSrcs) {
      if (!liveSrcs.has(src)) _historyKnownSrcs.delete(src);
    }
  }, 2000);
}

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

chrome.runtime.onMessage.addListener((req: unknown, _sender, sendResponse) => {
  const r = req as { type?: string };
  switch (r.type) {
    case 'naisu.query.anlas':
      sendResponse({ anlas: readAnlas(), running: isRunning() });
      return false;
    case 'naisu.batch.start':
      void runBatch();
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
    case 'naisu.ui.reset':
      unmountPanel();
      mountPanel(true);
      wireHandlers();
      sendResponse({ ok: true });
      return false;
  }
  return false;
});
