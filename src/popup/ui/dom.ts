/** 팝업 전역에서 쓰는 최소한의 DOM 헬퍼. */

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T | null =>
  document.querySelector(sel) as T | null;

export const $$ = <T extends HTMLElement = HTMLElement>(sel: string): T[] =>
  Array.from(document.querySelectorAll<T>(sel));

/** 반드시 존재해야 하는 노드 — 없으면 마크업이 어긋난 것이므로 바로 드러내는 편이 낫다. */
export function must<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector(sel) as T | null;
  if (!el) throw new Error(`[naisu] 팝업 노드를 찾을 수 없습니다: ${sel}`);
  return el;
}

export function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}
