/**
 * 얕은 화면 라우터 — [data-nav] 클릭으로 <section data-screen> 을 토글한다.
 * 라이브러리 없이 hidden 속성만 쓴다.
 *
 * 화면 모듈을 여기서 import하지 않는 이유: 화면이 nav()를 부르고 라우터가 화면을
 * 부르면 순환 참조가 된다. 등록은 popup.ts가 한다.
 */

import { $$ } from './ui/dom';
import type { Screen } from './screens/types';

let screens: Screen[] = [];
let current = '';

export function registerScreens(list: Screen[]): void {
  screens = list;
}

export function nav(name: string): void {
  current = name;
  $$('.screen').forEach((s) => (s.hidden = s.dataset.screen !== name));
  void screens.find((s) => s.name === name)?.enter?.();
}

export function currentScreen(): string {
  return current;
}

export function bindRouter(): void {
  document.body.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
    if (!target) return;
    e.preventDefault();
    nav(target.dataset.nav!);
  });
}
