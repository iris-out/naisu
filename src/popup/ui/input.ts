/** 입력 → 디바운스 저장. 팝업의 모든 설정 입력이 이 패턴을 쓴다. */

import { $ } from './dom';

const DEBOUNCE_MS = 200;

export function bindInput(
  sel: string,
  value: string,
  save: (v: string) => Promise<unknown> | void,
): void {
  const el = $<HTMLInputElement>(sel);
  if (!el) return;
  el.value = value;
  let timer: number | undefined;
  el.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => void save(el.value), DEBOUNCE_MS);
  });
}
