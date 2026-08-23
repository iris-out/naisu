/**
 * 레지스트리(settings-registry.ts)를 화면에 그릴 때 쓰는 작은 조각들.
 * 화면마다 다시 만들지 않도록 여기 모아 둔다.
 */

import { getSettings, setSettings, type Settings } from '../../lib/storage';
import {
  defaultPatch,
  defaultPatchOfScreen,
  isModified,
  riskOfScreen,
  type RiskLevel,
  type ScreenId,
} from '../settings-registry';
import { flashHint } from './status';

/** 위험도 배지 HTML — 화면 상단이나 홈 메뉴 요약에 붙인다 */
export function riskBadge(level: RiskLevel, text?: string): string {
  const label = text ?? ({ ok: '안전', warn: '주의', danger: '위험' }[level]);
  return `<span class="badge badge-${level}">${label}</span>`;
}

/** 값이 만드는 결과를 설명하는 회색 한 줄 (숫자 옆에 붙이는 그 문장) */
export function helpLine(text: string): string {
  return `<div class="field-help">${text}</div>`;
}

/** 위험 경고 줄 — risk()가 warn/danger를 돌려줬을 때만 보인다 */
export function riskLine(level: RiskLevel, message?: string): string {
  if (level === 'ok' || !message) return '';
  return `<div class="field-risk ${level}">${message}</div>`;
}

/**
 * "↺ 기본값" 되돌리기 버튼을 붙인다.
 * 기본값과 같은 동안에는 숨겨 두어 화면이 시끄러워지지 않게 한다.
 */
export function bindRevert(
  el: HTMLElement,
  key: keyof Settings,
  onDone: () => void | Promise<void>,
): void {
  const sync = async () => {
    el.hidden = !isModified(key, await getSettings());
  };
  el.addEventListener('click', async () => {
    await setSettings(defaultPatch(key));
    flashHint('기본값으로 되돌렸습니다');
    await onDone();
    await sync();
  });
  void sync();
}

/** 화면 하나를 통째로 기본값으로 */
export function bindRevertScreen(
  el: HTMLElement,
  screen: ScreenId,
  onDone: () => void | Promise<void>,
): void {
  el.addEventListener('click', async () => {
    await setSettings(defaultPatchOfScreen(screen));
    flashHint('이 화면을 기본값으로 되돌렸습니다');
    await onDone();
  });
}

/** 화면 상단 상태 배지를 갱신 */
export async function refreshScreenRisk(el: HTMLElement | null, screen: ScreenId): Promise<void> {
  if (!el) return;
  const v = riskOfScreen(screen, await getSettings());
  el.innerHTML = riskBadge(v.level, v.level === 'ok' ? '현재 안전' : undefined);
}
