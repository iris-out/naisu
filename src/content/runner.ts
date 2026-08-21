/**
 * 배치 러너 — content script 측에서 동작.
 * - 변주 전개를 순회하며 프롬프트 주입 → Generate 클릭 → 결과 대기 → 다운로드 → 반복
 * - Anlas 하한 / 에러 토스트 / 타임아웃 / 일시정지·중단 안전장치
 */

import { SEL, pickVisible, findGenerateButton, readAnlas, findSeedButton, filterMainGridImages } from './selectors';
import { pmSetText, blobUrlToBytes, bytesToBase64, waitForNewImages, ensureRandomSeed } from './dom-helpers';
import { getToast } from './overlay';
import { getSettings, getTemplate, renderFilename, type Settings } from '../lib/storage';
import { expand, totalCount } from '../lib/prompt-variator';
import { parseNaiWebP, summarize } from '../lib/nai-metadata';
import { postEvent } from '../lib/discord';

function setBadge(text: string, color = '#222222'): void {
  void chrome.runtime.sendMessage({ type: 'naisu.badge', payload: { text, color } }).catch(() => {});
}

interface RunState {
  paused: boolean;
  stopped: boolean;
}

let active: RunState | null = null;

export function isRunning(): boolean {
  return active !== null && !active.stopped;
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
  pmSetText(pm, text);
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

interface StripStatus { mode: string; level: 'good' | 'info' | 'bad'; message: string; detail?: string }

async function downloadGenerated(
  img: HTMLImageElement,
  settings: Settings,
  batchName: string,
  idx: number,
  /** NAI가 한 번에 여러 장(최대 4장)을 그리드로 생성했을 때, 파일명 충돌을 피하려고 붙이는 접미사(예: "_g2") */
  gridSuffix = '',
): Promise<{ saved: number; meta: ReturnType<typeof summarize>; error?: string; stripStatus?: StripStatus }> {
  const bytes = await blobUrlToBytes(img.src);
  const meta = parseNaiWebP(bytes);
  const s = summarize(meta);
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
  interface DownloadResp { saved?: string[]; errors?: string[]; error?: string; stripStatus?: StripStatus }
  let resp: DownloadResp | undefined;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'naisu.download',
      payload: {
        bytes: bytesToBase64(bytes),
        mode: settings.downloadMode,
        folder: `${settings.downloadFolder}/${batchName}`,
        filename,
        strip: { keepIccp: settings.keepColorProfile },
      },
    });
  } catch (e) {
    return { saved: 0, meta: s, error: `다운로드 요청 실패: ${e}` };
  }
  if (resp?.error) return { saved: 0, meta: s, error: String(resp.error), stripStatus: resp.stripStatus };
  if (resp?.errors?.length) {
    return { saved: resp.saved?.length ?? 0, meta: s, error: resp.errors.join('; '), stripStatus: resp.stripStatus };
  }
  return { saved: Array.isArray(resp?.saved) ? resp.saved.length : 0, meta: s, stripStatus: resp?.stripStatus };
}

export async function runBatch(maxItems?: number): Promise<void> {
  if (active) {
    console.warn('[naisu] 이미 실행 중');
    return;
  }
  const t = await getTemplate();
  const settings = await getSettings();
  const total = maxItems !== undefined ? Math.max(1, Math.floor(maxItems)) : totalCount(t);

  active = { paused: false, stopped: false };
  const toast = getToast();
  toast.show();
  setBadge(String(total), '#222222');
  toast.setStatus('실행 중');
  toast.setProgress(0, total);
  toast.log(`배치 시작 — 총 ${total}장`, 'info');

  const startedAt = Date.now();
  const batchName = `batch_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const startAnlas = readAnlas() ?? 0;
  const perItemAnlas = 17; // 어림 (832×1216, 23step). 실제로는 매번 readAnlas로 보정.
  const estimateMin = Math.round(((total * (settings.cooldownMs + 12_000)) / 1000) / 60);

  await postEvent(settings.discord, {
    kind: 'start',
    total,
    estimateMin,
    anlasUsed: total * perItemAnlas,
    templateName: t.name,
  });

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

  let done = 0;
  let retryStreak = 0;

  // 배치 시작 전 원본 프롬프트 저장 — finally에서 복원
  const pmEl = pickVisible<HTMLElement>(SEL.mainPrompt);
  const originalPrompt = pmEl ? (pmEl.textContent ?? '') : null;

  try {
    for (const item of expand(t, Math.random, total)) {
      if (active.stopped) break;
      await waitWhile(() => active!.paused);

      const anlas = readAnlas();
      if (anlas !== null && anlas < settings.anlasFloor) {
        toast.log(`Anlas 부족 (${anlas} < ${settings.anlasFloor}) — 중단`, 'bad');
        await postEvent(settings.discord, {
          kind: 'pause',
          reason: `Anlas 부족 (${anlas})`,
        });
        break;
      }

      try {
        const label = item.preset.text || '(변형 없음)';
        toast.log(`#${item.idx + 1} · ${label.slice(0, 30)}${label.length > 30 ? '…' : ''}`, 'info');
        if (t.usePresets) await injectPrompt(item.prompt);

        // 시드 무작위화 (NAI 시드가 고정되어 있으면 같은 이미지가 반복되므로)
        if (t.randomSeed) {
          const seedBtn = findSeedButton();
          if (seedBtn) {
            const ok = await ensureRandomSeed(seedBtn);
            if (!ok && seedBtn.textContent?.trim() !== 'N/A') {
              throw new Error('시드 무작위화 실패 — 같은 이미지가 반복되어 중단합니다');
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
          const r = await downloadGenerated(imgs[g], settings, batchName, item.idx, isGrid ? `_g${g + 1}` : '');
          results.push(r);
          const label = isGrid ? `#${item.idx + 1}-${g + 1}/${imgs.length}` : `#${item.idx + 1}`;
          if (r.error) {
            toast.log(`저장 실패 ${label} — ${r.error}`, 'bad');
          } else {
            toast.log(`저장 완료 ${label}${r.meta.seed ? ` · seed ${r.meta.seed}` : ''}`, 'good');
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
        const elapsed = (Date.now() - startedAt) / 1000;
        const eta = total > done ? (elapsed / done) * (total - done) : 0;
        toast.setProgress(done, total, eta);

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
        if (retryStreak >= settings.maxRetries) {
          toast.log('연속 오류로 중단합니다', 'bad');
          try { await postEvent(settings.discord, { kind: 'error', message: msg }); } catch { /* ignore */ }
          break;
        }
        // 점진 지연 1s → 2s → 4s
        const back = 1000 * Math.pow(2, retryStreak - 1);
        await sleep(back, () => active!.stopped);
        if (active.stopped) break;
        continue;
      }

      // 다음 장 전 쿨다운
      await sleep(settings.cooldownMs, () => active!.stopped);
    }
  } finally {
    // 원본 프롬프트 복원
    if (originalPrompt !== null) {
      const pm2 = pickVisible<HTMLElement>(SEL.mainPrompt);
      if (pm2) pmSetText(pm2, originalPrompt);
    }

    const dur = (Date.now() - startedAt) / 1000;
    const usedAnlas = Math.max(0, startAnlas - (readAnlas() ?? startAnlas));
    toast.setStatus('완료');
    toast.log(`완료 — ${done}/${total}장 · ${Math.round(dur)}초`, 'good');
    try {
      await postEvent(settings.discord, {
        kind: 'done',
        total: done,
        durationSec: dur,
        anlasUsed: usedAnlas,
      });
    } catch { /* SW 비활성 시 무시 */ }
    setBadge('');
    active = null;
  }
}

export function stopBatch(): void {
  if (active) active.stopped = true;
}

export function pauseBatch(): void {
  if (active) active.paused = !active.paused;
}
