/** 안전 설정 화면 — 배치를 자동으로 멈출 조건. */

import { getSettings, setSettings, type AnlasFloorAction, type Settings } from '../../lib/storage';
import { findField } from '../settings-registry';
import { must, $ } from '../ui/dom';
import { bindInput } from '../ui/input';
import { bindSeg } from '../ui/seg';
import { helpLine, riskLine, bindRevertScreen, refreshScreenRisk } from '../ui/field-ui';
import type { Screen } from './types';

/** 생성 간격 프리셋(ms). 목록에 없는 값이면 "직접"으로 취급한다. */
const COOLDOWN_PRESETS = [2000, 1500, 1000];

function cooldownPresetKey(ms: number): string {
  return COOLDOWN_PRESETS.includes(ms) ? String(ms) : 'custom';
}

function anlasHelpText(floor: number, onFloor: AnlasFloorAction): string {
  const n = Number.isFinite(floor) ? floor : 0;
  return `잔량이 ${n.toLocaleString()} 아래로 떨어지면 ${onFloor === 'pause' ? '일시정지' : '중단'}합니다.`;
}

function retriesHelpText(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return `최대 ${v}회까지, 1초 → 2초 → 4초 간격으로 다시 시도합니다.`;
}

function timeoutHelpText(sec: number): string {
  const v = Number.isFinite(sec) ? sec : 0;
  return `한 장이 ${v}초를 넘기면 실패로 처리합니다.`;
}

export const safetyScreen: Screen = {
  name: 'safety',

  render: () => `
    <section class="screen" data-screen="safety" hidden>
      <header class="hd sub">
        <button class="back" data-nav="home">←</button>
        <h2>안전 설정</h2>
        <span class="screen-head-right">
          <span id="safety-risk"></span>
          <button class="revert" id="safety-revert">↺ 기본값</button>
        </span>
      </header>

      <div class="card">
        <div class="hint mini" style="margin-bottom:10px">배치 실행 중 자동으로 멈출 조건을 설정합니다.</div>

        <div class="lbl">생성 속도</div>
        <div class="seg" id="cooldown-preset" role="radiogroup" style="--seg-n:4">
          <span class="seg-indicator"></span>
          <button data-v="2000">안전 2초</button>
          <button data-v="1500">보통 1.5초</button>
          <button data-v="1000">빠름 1초</button>
          <button data-v="custom">직접</button>
        </div>
        <div id="cooldown-custom-wrap" style="margin:8px 0" hidden>
          <input type="number" id="cooldown-custom" min="0" step="100"> ms
        </div>
        <div id="cooldown-help"></div>
        <div id="cooldown-risk"></div>

        <div class="kv-line" style="margin-top:12px">
          <span class="kv-key">Anlas 최솟값</span>
          <input type="number" id="anlas-floor" min="0" value="100">
        </div>
        <div id="anlas-floor-help"></div>
        <div style="margin:4px 0 12px">
          <div class="lbl mini">최솟값 도달 시</div>
          <div class="seg" id="anlas-floor-action" role="radiogroup" style="--seg-n:2">
            <span class="seg-indicator"></span>
            <button data-v="stop">중단</button>
            <button data-v="pause">일시정지</button>
          </div>
          <div id="anlas-floor-action-help"></div>
        </div>

        <div class="kv-line">
          <span class="kv-key">오류 재시도</span>
          <input type="number" id="retries" min="0" value="3"> 회
        </div>
        <div id="retries-help"></div>
        <div id="retries-risk"></div>

        <div class="kv-line">
          <span class="kv-key">생성 제한 시간</span>
          <input type="number" id="timeout" min="10" value="60"> 초
        </div>
        <div id="timeout-help"></div>
      </div>
    </section>
  `,

  async mount() {
    let current: Settings = await getSettings();

    const refreshBadge = () => refreshScreenRisk(must('#safety-risk'), 'safety');

    // ---------------- 생성 속도 (프리셋 + 직접) ----------------
    must('#cooldown-help').innerHTML = helpLine(findField('cooldownMs')?.help ?? '');

    function refreshCooldownRisk(ms: number): void {
      const risk = findField('cooldownMs')?.risk?.({ ...current, cooldownMs: ms }) ?? { level: 'ok' as const };
      must('#cooldown-risk').innerHTML = riskLine(risk.level, risk.message);
    }

    function showCooldownCustom(show: boolean): void {
      must('#cooldown-custom-wrap').hidden = !show;
    }

    const cooldownActivate = bindSeg(
      must('#cooldown-preset'),
      cooldownPresetKey(current.cooldownMs),
      async (v) => {
        if (v === 'custom') {
          showCooldownCustom(true);
          const input = must<HTMLInputElement>('#cooldown-custom');
          input.value = String(current.cooldownMs);
          input.focus();
          refreshCooldownRisk(current.cooldownMs);
          return;
        }
        showCooldownCustom(false);
        const ms = Number(v);
        current = { ...current, cooldownMs: ms };
        refreshCooldownRisk(ms);
        await setSettings({ cooldownMs: ms });
        await refreshBadge();
      },
    );

    showCooldownCustom(cooldownPresetKey(current.cooldownMs) === 'custom');
    if (cooldownPresetKey(current.cooldownMs) === 'custom') {
      must<HTMLInputElement>('#cooldown-custom').value = String(current.cooldownMs);
    }
    refreshCooldownRisk(current.cooldownMs);

    must<HTMLInputElement>('#cooldown-custom').addEventListener('input', (e) => {
      const ms = Number((e.target as HTMLInputElement).value) || 0;
      current = { ...current, cooldownMs: ms };
      refreshCooldownRisk(ms);
    });
    bindInput('#cooldown-custom', String(current.cooldownMs), async (v) => {
      const ms = Number(v) || 0;
      await setSettings({ cooldownMs: ms });
      await refreshBadge();
    });

    // ---------------- Anlas 최솟값 ----------------
    let onFloor: AnlasFloorAction = current.onAnlasFloor;

    function refreshAnlasHelp(floor: number): void {
      must('#anlas-floor-help').innerHTML = helpLine(anlasHelpText(floor, onFloor));
    }

    must<HTMLInputElement>('#anlas-floor').addEventListener('input', (e) => {
      refreshAnlasHelp(Number((e.target as HTMLInputElement).value) || 0);
    });
    bindInput('#anlas-floor', String(current.anlasFloor), async (v) => {
      const floor = Number(v) || 0;
      current = { ...current, anlasFloor: floor };
      await setSettings({ anlasFloor: floor });
    });
    refreshAnlasHelp(current.anlasFloor);

    must('#anlas-floor-action-help').innerHTML = helpLine(findField('onAnlasFloor')?.help ?? '');
    const anlasActionActivate = bindSeg(must('#anlas-floor-action'), current.onAnlasFloor, async (v) => {
      onFloor = v as AnlasFloorAction;
      current = { ...current, onAnlasFloor: onFloor };
      const floorInput = $<HTMLInputElement>('#anlas-floor');
      refreshAnlasHelp(Number(floorInput?.value) || 0);
      await setSettings({ onAnlasFloor: onFloor });
    });

    // ---------------- 오류 재시도 ----------------
    function refreshRetriesInfo(n: number): void {
      must('#retries-help').innerHTML = helpLine(retriesHelpText(n));
      const risk = findField('maxRetries')?.risk?.({ ...current, maxRetries: n }) ?? { level: 'ok' as const };
      must('#retries-risk').innerHTML = riskLine(risk.level, risk.message);
    }

    must<HTMLInputElement>('#retries').addEventListener('input', (e) => {
      refreshRetriesInfo(Number((e.target as HTMLInputElement).value) || 0);
    });
    bindInput('#retries', String(current.maxRetries), async (v) => {
      const n = Number(v) || 0;
      current = { ...current, maxRetries: n };
      await setSettings({ maxRetries: n });
      await refreshBadge();
    });
    refreshRetriesInfo(current.maxRetries);

    // ---------------- 생성 제한 시간 ----------------
    function refreshTimeoutHelp(sec: number): void {
      must('#timeout-help').innerHTML = helpLine(timeoutHelpText(sec));
    }

    must<HTMLInputElement>('#timeout').addEventListener('input', (e) => {
      refreshTimeoutHelp(Number((e.target as HTMLInputElement).value) || 0);
    });
    bindInput('#timeout', String(current.timeoutMs / 1000), async (v) => {
      const sec = Number(v) || 60;
      current = { ...current, timeoutMs: sec * 1000 };
      await setSettings({ timeoutMs: sec * 1000 });
    });
    refreshTimeoutHelp(current.timeoutMs / 1000);

    // ---------------- 상단 상태 배지 & 되돌리기 ----------------
    await refreshBadge();

    bindRevertScreen(must('#safety-revert'), 'safety', async () => {
      current = await getSettings();
      onFloor = current.onAnlasFloor;

      const key = cooldownPresetKey(current.cooldownMs);
      cooldownActivate(key);
      showCooldownCustom(key === 'custom');
      must<HTMLInputElement>('#cooldown-custom').value = String(current.cooldownMs);
      refreshCooldownRisk(current.cooldownMs);

      must<HTMLInputElement>('#anlas-floor').value = String(current.anlasFloor);
      refreshAnlasHelp(current.anlasFloor);
      anlasActionActivate(current.onAnlasFloor);

      must<HTMLInputElement>('#retries').value = String(current.maxRetries);
      refreshRetriesInfo(current.maxRetries);

      must<HTMLInputElement>('#timeout').value = String(current.timeoutMs / 1000);
      refreshTimeoutHelp(current.timeoutMs / 1000);

      await refreshBadge();
    });
  },
};
