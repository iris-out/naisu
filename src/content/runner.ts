/**
 * 배치 러너 — content script 측에서 동작.
 * - 변주 전개를 순회하며 프롬프트 주입 → Generate 클릭 → 결과 대기 → 다운로드 → 반복
 * - Anlas 하한 / 에러 토스트 / 타임아웃 / 일시정지·중단 안전장치
 * - 중단 지점은 배치 커서로 저장돼(N07) 새로고침·탭 이동 후에도 이어서 실행할 수 있다.
 */

import {
  SEL,
  pickVisible,
  findGenerateButton,
  readAnlas,
  findSeedButton,
  filterMainGridImages,
  ANLAS_FALLBACK_PER_ITEM,
  parseAnlasCostFromGenerateButton,
} from './selectors';

// 패널이 실행 전 예상 비용을 그리려면 이 함수가 필요한데, overlay가 runner를 import하면
// runner → overlay → runner 순환이 된다. 순수 DOM 읽기라 selectors.ts로 옮기고 여기서는
// 기존 호출부(content/index.ts의 naisu.query.anlas 응답)를 위해 그대로 다시 내보낸다.
export { parseAnlasCostFromGenerateButton };
import { pmSetText, blobUrlToBytes, bytesToBase64, waitForNewImages, ensureRandomSeed } from './dom-helpers';
import { getToast, ensureDisclaimerAccepted } from './overlay';
import {
  getSettings,
  getTemplate,
  getTemplateById,
  renderFilename,
  renderFolder,
  getBatchCursor,
  setBatchCursor,
  clearBatchCursor,
  addReport,
  type Settings,
  type BatchTemplate,
  type BatchCursor,
  type BatchReport,
  type BatchFailure,
} from '../lib/storage';
import { expand, totalCount } from '../lib/prompt-variator';
import { parseNaiWebP, summarize } from '../lib/nai-metadata';
import { addHistoryEntry } from '../lib/history';
import { postEvent } from '../lib/discord';
import { sendMessage, trySendMessage, type RunState, type StripStatusReport } from '../lib/messages';
import { cacheImage } from './image-cache';

function setBadge(text: string, color = '#222222'): void {
  void trySendMessage('naisu.badge', { text, color });
}

/** 실행 중인 배치의 제어 플래그 (일시정지/중단) */
interface ActiveRun {
  paused: boolean;
  stopped: boolean;
}

let active: ActiveRun | null = null;

/**
 * 진행률 — 팝업이 실행 중 화면을 그릴 때 읽어간다(B04).
 * 패널만 알고 있던 값이라 모듈 스코프로 끌어올렸다.
 */
let progress = { done: 0, total: 0, etaSec: 0 };

export function isRunning(): boolean {
  return active !== null && !active.stopped;
}

/** 팝업의 naisu.query.anlas 응답에 실려 나가는 현재 상태. */
export function getRunState(): RunState {
  return {
    running: isRunning(),
    paused: active?.paused ?? false,
    done: progress.done,
    total: progress.total,
    etaSec: progress.etaSec,
  };
}

/**
 * B02: 러너가 이미 blob을 fetch해서 EXIF까지 파싱한 이미지 src 집합.
 * content/index.ts의 이력 워처가 같은 이미지를 또 fetch·파싱하지 않도록 여기서 표시해 둔다.
 */
const historyHandledSrcs = new Set<string>();

export function wasSavedByRunner(src: string): boolean {
  return historyHandledSrcs.has(src);
}

function sleep(ms: number, signal: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (signal() || Date.now() - start >= ms) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });
}

async function waitWhile(cond: () => boolean, every = 200): Promise<void> {
  while (cond()) await new Promise((r) => setTimeout(r, every));
}

async function injectPrompt(text: string): Promise<void> {
  const pm = pickVisible<HTMLElement>(SEL.mainPrompt);
  if (!pm) throw new Error('프롬프트 영역을 찾을 수 없습니다');
  if (!pmSetText(pm, text)) {
    throw new Error('프롬프트 입력에 실패했습니다 — NAI 화면에서 Prompt 탭이 열려 있는지 확인해 주세요');
  }
}

async function clickGenerate(): Promise<void> {
  const btn = findGenerateButton();
  if (!btn) throw new Error('생성 버튼을 찾을 수 없습니다');
  btn.click();
}

function snapshotKnownImageSrcs(): Set<string> {
  const set = new Set<string>();
  document
    .querySelectorAll<HTMLImageElement>(SEL.resultImage)
    .forEach((i) => i.src && set.add(i.src));
  return set;
}

async function downloadGenerated(
  img: HTMLImageElement,
  settings: Settings,
  folder: string,
  batchName: string,
  idx: number,
  /** NAI가 한 번에 여러 장(최대 4장)을 그리드로 생성했을 때, 파일명 충돌을 피하려고 붙이는 접미사(예: "_g2") */
  gridSuffix = '',
): Promise<{
  saved: number;
  meta: ReturnType<typeof summarize>;
  error?: string;
  stripStatus?: StripStatusReport;
  /** 결과 타임라인 줄에 실어 줄 값들 (폴더 열기 · 다시 저장에 필요) */
  files?: Array<{ path: string; downloadId: number | null }>;
  cacheId?: string;
  opsNote?: string;
  /** 매니페스트 CSV 한 줄에 쓸 실제 저장 경로 */
  primaryPath?: string;
}> {
  const bytes = await blobUrlToBytes(img.src);
  const meta = parseNaiWebP(bytes);
  const s = summarize(meta);

  // B02: 파일명용으로 이미 파싱한 결과를 그대로 이력에 저장 — 워처가 같은 blob을 다시
  // fetch·파싱하지 않도록 src를 먼저 "처리됨"으로 표시해 둔다.
  historyHandledSrcs.add(img.src);
  if (s.prompt || s.seed) {
    try {
      const chars = s.characters.map((c) => (c?.char_caption ?? '').trim()).filter(Boolean);
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
      console.error('[naisu] 이력 저장 실패', e);
    }
  }

  const filename =
    renderFilename(settings.filenameTemplate, {
      seed: s.seed,
      model: s.model,
      w: s.width,
      h: s.height,
      steps: s.steps,
      sampler: s.sampler,
      batch: batchName,
      idx: idx + 1,
    }) + gridSuffix;
  // 원본 바이트 캐시 — 배치 중 하드클린이 조용히 실패해도 나중에 다시 저장할 수 있게.
  // 실패해도 배치를 막지 않는다(cacheImage 자체가 예외를 삼키고 false를 돌려준다).
  const cacheId = `b${Date.now().toString(36)}-${idx}${gridSuffix}`;
  const cached = await cacheImage(
    { id: cacheId, bytes: bytes.slice().buffer, filename, seed: s.seed, model: s.model, prompt: s.prompt },
    settings.cacheLimit,
  );

  let resp: Awaited<ReturnType<typeof sendMessage<'naisu.download'>>> | undefined;
  try {
    resp = await sendMessage('naisu.download', {
      bytes: bytesToBase64(bytes),
      mode: settings.downloadMode,
      folder,
      filename,
      strip: { keepIccp: settings.keepColorProfile },
      conflictAction: settings.conflictAction,
      imageOps: settings.imageOps,
    });
  } catch (e) {
    return { saved: 0, meta: s, error: `다운로드 요청 실패: ${e}`, cacheId: cached ? cacheId : undefined };
  }
  const files = (resp?.items ?? []).map((i) => ({ path: i.path, downloadId: i.downloadId }));
  const common = {
    meta: s,
    stripStatus: resp?.stripStatus,
    files,
    cacheId: cached ? cacheId : undefined,
    opsNote: resp?.opsNote,
    primaryPath: resp?.saved?.[0],
  };
  if (resp?.error) return { saved: 0, error: String(resp.error), ...common };
  if (resp?.errors?.length) {
    return { saved: resp.saved?.length ?? 0, error: resp.errors.join('; '), ...common };
  }
  return { saved: Array.isArray(resp?.saved) ? resp.saved.length : 0, ...common };
}

/**
 * 배치 매니페스트 CSV.
 *
 * 클린/하드클린 저장은 이미지에서 프롬프트·시드를 지운다. 그건 의도된 동작이지만,
 * 그 결과 "이 그림 어떻게 뽑았더라"를 되짚을 방법도 같이 사라진다.
 * 매니페스트는 그 짝이다 — 재현 정보를 이미지 밖 파일 하나에 남긴다.
 */
interface ManifestRow {
  idx: number;
  path: string;
  seed?: number;
  model?: string;
  sampler?: string;
  steps?: number;
  prompt: string;
}

function toCsv(rows: ManifestRow[]): string {
  const esc = (v: unknown): string => {
    const s = v === undefined || v === null ? '' : String(v);
    // 프롬프트에는 쉼표·따옴표·줄바꿈이 흔하다 — RFC4180대로 감싸고 따옴표는 두 번 쓴다.
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['idx', 'file', 'seed', 'model', 'sampler', 'steps', 'prompt'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.idx, r.path, r.seed, r.model, r.sampler, r.steps, r.prompt].map(esc).join(','));
  }
  return lines.join('\r\n');
}

interface RunOptions {
  maxItems?: number;
  /** N07: 중단된 배치를 이어서 실행할 때 넘어오는 커서 */
  resume?: BatchCursor;
}

/** 팝업/패널/단축키 세 진입점 전부가 결국 이 함수로 모인다 — D01 게이트를 여기 한 곳에만 둔다. */
async function runBatchCore(opts: RunOptions): Promise<void> {
  if (active) {
    console.warn('[naisu] 이미 실행 중');
    return;
  }

  // D01: 자동 다운로드 약관 미동의면 아무것도 하지 않고 반환. 수동 저장(manualDownload)은
  // 이 게이트 대상이 아니므로 runBatchCore 밖에서 호출된다.
  const disclaimerOk = await ensureDisclaimerAccepted();
  if (!disclaimerOk) return;

  const settings = await getSettings();
  const resume = opts.resume;

  let t: BatchTemplate;
  if (resume) {
    const found = await getTemplateById(resume.templateId);
    if (found) {
      t = found;
    } else {
      console.warn('[naisu] 이어하기 대상 템플릿을 찾지 못해 현재 활성 템플릿으로 대체합니다');
      t = await getTemplate();
    }
  } else {
    t = await getTemplate();
  }

  const total = resume ? resume.total : (opts.maxItems !== undefined ? Math.max(1, Math.floor(opts.maxItems)) : totalCount(t));
  const startIdx = resume ? Math.max(0, Math.min(resume.nextIdx, total)) : 0;
  const batchName = resume ? resume.batchId : `batch_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const batchFolder = resume ? resume.folder : renderFolder(settings, { batch: batchName, template: t.name });

  active = { paused: false, stopped: false };
  progress = { done: startIdx, total, etaSec: 0 };
  // 긴 배치가 시스템 절전으로 끊기지 않게 — finally에서 반드시 해제한다.
  // content script에는 chrome.power가 없어 SW가 대신 호출한다.
  if (settings.keepAwake) void trySendMessage('naisu.power', { on: true });
  const toast = getToast();
  toast.show();
  setBadge(String(total - startIdx), '#222222');
  toast.setStatus('실행 중');
  toast.setProgress(startIdx, total);
  toast.log(resume ? `이어서 시작 — ${startIdx}/${total}장부터` : `배치 시작 — 총 ${total}장`, 'info');

  const startedAt = resume ? resume.startedAt : Date.now();
  const sessionStartedAt = Date.now();
  const startAnlas = readAnlas() ?? 0;

  let perItemAnlas = parseAnlasCostFromGenerateButton();
  if (perItemAnlas === null) {
    perItemAnlas = ANLAS_FALLBACK_PER_ITEM;
    console.warn(`[naisu] Generate 버튼에서 Anlas 단가를 못 읽어 어림값(${ANLAS_FALLBACK_PER_ITEM})을 사용합니다`);
    toast.log(`Anlas 단가를 못 읽어 어림값(${ANLAS_FALLBACK_PER_ITEM} ₳/장)을 사용합니다`, 'info');
  }
  const remainingCount = total - startIdx;
  const estimateMin = Math.round(((remainingCount * (settings.cooldownMs + 12_000)) / 1000) / 60);

  if (!resume) {
    await postEvent(settings.discord, {
      kind: 'start',
      total,
      estimateMin,
      anlasUsed: total * perItemAnlas,
      templateName: t.name,
    });
  }

  toast.onPause(() => {
    if (!active) return;
    active.paused = !active.paused;
    toast.setStatus(active.paused ? '일시정지' : '실행 중');
    toast.log(active.paused ? '일시정지' : '재개', 'info');
    if (active.paused) {
      void postEvent(settings.discord, { kind: 'pause', reason: '사용자가 일시정지했습니다' });
    }
  });
  toast.onStop(() => {
    if (!active) return;
    active.stopped = true;
    toast.log('중단됨', 'bad');
  });

  let done = startIdx;
  let savedFiles = 0;
  /** 배치가 끝나면 CSV 한 개로 저장할 재현 정보 (Settings.writeManifest가 켜져 있을 때만) */
  const manifestRows: ManifestRow[] = [];
  /** 완료 알림의 "폴더 열기" 버튼이 열어 줄 파일 — 마지막으로 성공한 저장 */
  let lastSavedDownloadId: number | null = null;
  /** Anlas 하한 자동 재개를 다음에 확인할 시각 (autoResumeMin이 0이면 항상 null) */
  let autoResumeAt: number | null = null;
  let retryStreak = 0;
  let stoppedBy: BatchReport['stoppedBy'] = 'complete';
  const failures: BatchFailure[] = [];

  const saveCursor = (reason: BatchCursor['reason'], nextIdx: number): Promise<void> =>
    setBatchCursor({ batchId: batchName, templateId: t.id, total, nextIdx, startedAt, folder: batchFolder, reason });

  // 배치 시작 전 원본 프롬프트 저장 — finally에서 복원
  const pmEl = pickVisible<HTMLElement>(SEL.mainPrompt);
  const originalPrompt = pmEl ? (pmEl.textContent ?? '') : null;

  try {
    outer: for (const item of expand(t, Math.random, total)) {
      if (item.idx < startIdx) continue;

      // 일시정지(사용자 토글 또는 N11 Anlas 하한 자동 일시정지)가 풀릴 때까지 여기서 대기
      while (true) {
        if (active.stopped) {
          stoppedBy = 'user';
          await saveCursor('user', item.idx);
          break outer;
        }
        await waitWhile(() => active!.paused && !active!.stopped);
        if (active.stopped) {
          stoppedBy = 'user';
          await saveCursor('user', item.idx);
          break outer;
        }

        const anlas = readAnlas();
        if (anlas !== null && anlas < settings.anlasFloor) {
          if (settings.onAnlasFloor === 'pause') {
            if (!active.paused) {
              active.paused = true;
              toast.setStatus('일시정지');
              toast.log(`Anlas 부족 (${anlas} < ${settings.anlasFloor}) — 충전 후 이어서 실행하세요`, 'bad');
              await saveCursor('anlas', item.idx);
              await postEvent(settings.discord, { kind: 'pause', reason: `Anlas 부족 (${anlas})` });
              if (settings.notifications.anlasFloor) {
                void trySendMessage('naisu.notify', {
                  title: 'NAISU — Anlas 부족으로 일시정지',
                  message:
                    settings.autoResumeMin > 0
                      ? `Anlas ${anlas} — 하한(${settings.anlasFloor}) 아래로 떨어졌습니다. ${settings.autoResumeMin}분마다 다시 확인해 자동으로 재개합니다.`
                      : `Anlas ${anlas} — 하한(${settings.anlasFloor}) 아래로 떨어져 일시정지했습니다. 충전 후 패널에서 재개하세요.`,
                  kind: 'anlasFloor',
                });
              }
              // 자동 재개: 충전은 시간이 지나면 저절로 되는 일이라, 사람이 지켜보고 있다가
              // 다시 눌러야 하는 건 낭비다. 다만 "지금 되나?"를 계속 두드리지 않도록
              // 사용자가 정한 간격으로만 확인하고, 생성 간격 규칙은 그대로 지킨다.
              if (settings.autoResumeMin > 0) {
                autoResumeAt = Date.now() + settings.autoResumeMin * 60_000;
                toast.log(`${settings.autoResumeMin}분 뒤 Anlas를 다시 확인해 자동 재개합니다`, 'info');
              }
            } else if (autoResumeAt !== null && Date.now() >= autoResumeAt) {
              // 대기 시간이 지났다 — 지금 Anlas가 하한을 넘겼으면 스스로 재개한다.
              const now = readAnlas();
              if (now !== null && now >= settings.anlasFloor) {
                active.paused = false;
                autoResumeAt = null;
                toast.setStatus('실행 중');
                toast.log(`Anlas ${now} — 하한을 넘겨 자동 재개합니다`, 'good');
                continue;
              }
              autoResumeAt = Date.now() + settings.autoResumeMin * 60_000;
            }
            // 일시정지 상태에서 CPU를 태우지 않도록 잠깐 쉬었다 다시 확인한다
            await sleep(2000, () => active!.stopped);
            continue;
          }
          toast.log(`Anlas 부족 (${anlas} < ${settings.anlasFloor}) — 중단`, 'bad');
          stoppedBy = 'anlas';
          await saveCursor('anlas', item.idx);
          await postEvent(settings.discord, { kind: 'pause', reason: `Anlas 부족 (${anlas})` });
          if (settings.notifications.anlasFloor) {
            void trySendMessage('naisu.notify', {
              title: 'NAISU — Anlas 부족으로 배치 중단',
              message: `Anlas ${anlas} — 하한(${settings.anlasFloor}) 아래로 떨어져 배치를 중단했습니다.`,
              kind: 'anlasFloor',
            });
          }
          break outer;
        }
        break;
      }

      try {
        const label = item.preset.text || '(변형 없음)';
        toast.log(`#${item.idx + 1} · ${label.slice(0, 30)}${label.length > 30 ? '…' : ''}`, 'info');
        if (t.usePresets) await injectPrompt(item.prompt);

        // 시드 무작위화 (NAI 시드가 고정되어 있으면 같은 이미지가 반복되므로)
        if (t.randomSeed) {
          const seedBtn = findSeedButton();
          if (!seedBtn) {
            // 못 찾으면 시드가 고정된 채로 반복될 수 있다 — 조용히 넘어가지 않는다
            toast.log('시드 버튼을 찾지 못했습니다 — 시드가 고정되어 있으면 같은 이미지가 반복됩니다', 'bad');
          }
          if (seedBtn) {
            const seedResult = await ensureRandomSeed(seedBtn);
            // 'still-fixed'일 때만 중단한다 — 같은 시드로 같은 이미지를 반복 생성하면
            // Anlas만 태우기 때문. 반대로 '판단 불가'까지 중단으로 처리했더니 NAI가 시드
            // 표시를 아이콘으로 바꾼 뒤 배치가 통째로 0장이 되는 버그가 났었다.
            if (seedResult === 'still-fixed') {
              throw new Error(
                '시드가 고정되어 있습니다 — 같은 이미지가 반복되므로 중단합니다. ' +
                  'NAI 화면에서 시드를 비우거나(자동), 배치 설정에서 "매번 새 시드"를 꺼 주세요.',
              );
            }
            if (seedResult === 'unknown') {
              toast.log('시드 상태를 확인하지 못했습니다 — 그대로 진행합니다 (콘솔 로그 참고)', 'bad');
            }
          }
        }

        const known = snapshotKnownImageSrcs();
        await clickGenerate();
        await new Promise<void>((r) => setTimeout(r, 500));
        const errEl = document.querySelector(SEL.errorToast);
        if (errEl) throw new Error(`NAI 오류: ${errEl.textContent?.trim() ?? '알 수 없는 오류'}`);
        toast.setStatus(`생성 #${item.idx + 1}`);
        // NAI는 Generate 한 번으로 1~4장을 그리드로 동시 생성할 수 있음 — 새로 나타난 이미지 전부 수집
        // (History 사이드바에 새로 생긴 카드가 섞여 들어올 수 있어 크기 기반으로 한 번 더 거름)
        const imgs = filterMainGridImages(
          await waitForNewImages(SEL.resultImage, { timeoutMs: settings.timeoutMs, knownSrcs: known }),
        );
        if (imgs.length === 0) throw new Error('생성된 이미지를 찾지 못했습니다');
        const isGrid = imgs.length > 1;
        if (isGrid) toast.log(`그리드 ${imgs.length}장 감지됨 — 전부 저장합니다`, 'info');

        const results: Array<Awaited<ReturnType<typeof downloadGenerated>>> = [];
        for (let g = 0; g < imgs.length; g++) {
          const label2 = isGrid ? `#${item.idx + 1}-${g + 1}/${imgs.length}` : `#${item.idx + 1}`;
          const r = await downloadGenerated(
            imgs[g],
            settings,
            batchFolder,
            batchName,
            item.idx,
            isGrid ? `_g${g + 1}` : '',
          );
          results.push(r);
          savedFiles += r.saved;
          if (r.error) {
            toast.log(`저장 실패 ${label2} — ${r.error}`, 'bad');
            failures.push({ idx: item.idx, prompt: item.prompt, reason: r.error, detail: r.stripStatus?.detail });
          } else {
            toast.log(`저장 완료 ${label2}${r.meta.seed ? ` · seed ${r.meta.seed}` : ''}`, 'good');
            const okFile = r.files?.find((f) => f.downloadId !== null);
            if (okFile?.downloadId != null) lastSavedDownloadId = okFile.downloadId;
            if (r.primaryPath) {
              manifestRows.push({
                idx: item.idx + 1,
                path: r.primaryPath,
                seed: r.meta.seed,
                model: r.meta.model,
                sampler: r.meta.sampler,
                steps: r.meta.steps,
                prompt: item.prompt,
              });
            }
          }
          if (r.stripStatus) {
            toast.log(r.stripStatus.message, r.stripStatus.level);
            if (r.stripStatus.detail) console.error('[naisu] stripStatus 상세:', r.stripStatus.detail);
            if (r.stripStatus.level === 'bad') toast.alert(r.stripStatus.message);
          }
        }
        const meta = results[0]?.meta;

        retryStreak = 0;
        done++;
        setBadge(String(total - done));
        const elapsedSession = (Date.now() - sessionStartedAt) / 1000;
        const doneThisSession = done - startIdx;
        const eta = doneThisSession > 0 && total > done ? (elapsedSession / doneThisSession) * (total - done) : 0;
        progress = { done, total, etaSec: eta };
        toast.setProgress(done, total, eta);
        // N07: 완료한 장 뒤로 커서를 갱신해 둔다 — 새로고침 등으로 finally가 못 돌아도
        // 최소한 여기까지는 이어서 실행할 수 있게.
        await saveCursor('unload', done);

        const leftAnlas = readAnlas();
        if (
          settings.discord.events.progress &&
          done % Math.max(1, settings.discord.progressEvery) === 0
        ) {
          await postEvent(settings.discord, {
            kind: 'progress',
            done,
            total,
            etaSec: eta,
            anlasLeft: leftAnlas ?? 0,
          });
        }
        if (settings.discord.events.item) {
          await postEvent(settings.discord, {
            kind: 'item',
            idx: item.idx,
            total,
            prompt: item.prompt,
            seed: meta?.seed,
          });
        }
      } catch (e) {
        retryStreak++;
        const msg = e instanceof Error ? e.message : String(e);
        toast.log(`오류 (${retryStreak}회) — ${msg}`, 'bad');
        failures.push({ idx: item.idx, prompt: item.prompt, reason: msg });
        if (retryStreak >= settings.maxRetries) {
          toast.log('연속 오류로 중단합니다', 'bad');
          stoppedBy = 'error';
          try { await postEvent(settings.discord, { kind: 'error', message: msg }); } catch { /* ignore */ }
          if (settings.notifications.error) {
            void trySendMessage('naisu.notify', {
              title: 'NAISU — 배치가 오류로 중단됐습니다',
              message: msg,
              kind: 'error',
            });
          }
          await saveCursor('error', item.idx);
          break outer;
        }
        // 점진 지연 1s → 2s → 4s
        const back = 1000 * Math.pow(2, retryStreak - 1);
        await sleep(back, () => active!.stopped);
        if (active.stopped) {
          stoppedBy = 'user';
          await saveCursor('user', item.idx);
          break outer;
        }
        continue;
      }

      // 다음 장 전 쿨다운
      await sleep(settings.cooldownMs, () => active!.stopped);
      if (active.stopped) {
        stoppedBy = 'user';
        await saveCursor('user', done);
        break outer;
      }
    }
  } finally {
    // 원본 프롬프트 복원
    if (originalPrompt !== null) {
      const pm2 = pickVisible<HTMLElement>(SEL.mainPrompt);
      if (pm2 && !pmSetText(pm2, originalPrompt)) {
        console.warn('[naisu] 배치 종료 후 원본 프롬프트 복원에 실패했습니다');
      }
    }

    const dur = (Date.now() - startedAt) / 1000;
    const usedAnlas = Math.max(0, startAnlas - (readAnlas() ?? startAnlas));
    toast.setStatus('완료');
    toast.log(`완료 — ${done}/${total}장 · ${Math.round(dur)}초`, 'good');

    // N07: 목표 장수를 전부 채우고 자연 종료한 경우에만 커서를 지운다 — 그 외(중단/오류/
    // Anlas 하한)에는 이어서 실행할 수 있도록 남겨 둔다.
    if (stoppedBy === 'complete') {
      await clearBatchCursor();
    }

    // U07: 실행 리포트를 남긴다 — 패널 로그는 새로고침하면 사라지지만 리포트는 팝업에서 조회 가능.
    const report: BatchReport = {
      batchId: batchName,
      templateName: t.name,
      startedAt,
      finishedAt: Date.now(),
      total,
      done,
      savedFiles,
      anlasUsed: usedAnlas,
      stoppedBy,
      failures,
    };
    try {
      await addReport(report);
    } catch (e) {
      console.error('[naisu] 배치 리포트 저장 실패', e);
    }

    try {
      await postEvent(settings.discord, {
        kind: 'done',
        total: done,
        durationSec: dur,
        anlasUsed: usedAnlas,
      });
    } catch { /* SW 비활성 시 무시 */ }

    // 매니페스트 — 클린 저장이 이미지에서 지운 재현 정보를 배치 폴더에 CSV로 남긴다.
    if (settings.writeManifest && manifestRows.length > 0) {
      const r = await trySendMessage('naisu.download.manifest', {
        folder: batchFolder,
        name: `${batchName}_manifest`,
        csv: toCsv(manifestRows),
      });
      if (r?.ok) toast.log(`매니페스트 저장됨 — ${manifestRows.length}줄`, 'good');
      else if (r) toast.log(`매니페스트 저장 실패 — ${r.reason ?? '알 수 없는 이유'}`, 'bad');
    }

    if (stoppedBy === 'complete' && settings.notifications.done) {
      // 알림에서 바로 폴더를 열 수 있게 마지막으로 저장된 파일의 id를 실어 보낸다.
      const lastId = lastSavedDownloadId ?? undefined;
      void trySendMessage('naisu.notify', {
        title: 'NAISU — 배치 완료',
        message: `${done}/${total}장 완료 · ${Math.round(dur)}초 · ${usedAnlas} ₳ 사용`,
        kind: 'done',
        actions: lastId !== undefined ? ['openFolder'] : undefined,
        downloadId: lastId,
      });
    }

    if (stoppedBy === 'error' && settings.notifications.error) {
      void trySendMessage('naisu.notify', {
        title: 'NAISU — 배치 중단(오류)',
        message: `${done}/${total}장에서 멈췄습니다. 다시 시도하면 이어서 실행합니다.`,
        kind: 'error',
        actions: ['retry'],
      });
    }

    if (settings.keepAwake) void trySendMessage('naisu.power', { on: false });
    setBadge('');
    active = null;
    progress = { done: 0, total: 0, etaSec: 0 };
  }
}

export async function runBatch(maxItems?: number): Promise<void> {
  await runBatchCore({ maxItems });
}

/** N07: 중단된 배치를 커서부터 이어서 실행 (naisu.batch.resume 메시지 핸들러가 호출) */
export async function resumeBatch(): Promise<void> {
  if (active) {
    console.warn('[naisu] 이미 실행 중');
    return;
  }
  const cursor = await getBatchCursor();
  if (!cursor) {
    console.warn('[naisu] 이어서 실행할 배치 커서가 없습니다');
    getToast().log('이어서 실행할 배치가 없습니다', 'info');
    return;
  }
  if (cursor.nextIdx >= cursor.total) {
    await clearBatchCursor();
    return;
  }
  getToast().log(`${cursor.total - cursor.nextIdx}장 남은 배치를 이어서 실행합니다`, 'info');
  await runBatchCore({ resume: cursor });
}

export function stopBatch(): void {
  if (active) active.stopped = true;
}

export function pauseBatch(): void {
  if (active) active.paused = !active.paused;
}
