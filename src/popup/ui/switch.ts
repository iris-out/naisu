/** 온/오프 스위치. */

export function bindSwitch(
  el: HTMLElement,
  value: boolean,
  onChange: (v: boolean) => unknown,
): void {
  // 마크업(`<span class="switch">`)은 screens/*.ts 소유라 못 고치므로, 여기서 런타임에
  // 접근성 속성을 전부 부여한다. role/tabindex로 키보드 포커스가 가능해지고,
  // aria-checked로 스크린리더가 켜짐/꺼짐 상태를 읽는다.
  el.setAttribute('role', 'switch');
  if (!el.hasAttribute('tabindex')) el.tabIndex = 0;

  const apply = (v: boolean) => {
    el.classList.toggle('on', v);
    el.setAttribute('aria-checked', String(v));
  };

  // `locked` 클래스는 screens/batch.ts가 렌더 이후에도 계속 토글하므로(다른 스위치 상태에
  // 따라 잠금이 풀리거나 걸림), MutationObserver로 class 변화를 지켜보며 aria-disabled를
  // 그때그때 맞춘다.
  const syncLocked = () => {
    if (el.classList.contains('locked')) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
  };
  const observer = new MutationObserver(syncLocked);
  observer.observe(el, { attributes: true, attributeFilter: ['class'] });

  apply(value);
  syncLocked();

  const toggle = async () => {
    if (el.classList.contains('locked')) return;
    const next = !el.classList.contains('on');
    apply(next);
    el.classList.remove('just-toggled');
    void el.offsetWidth;
    el.classList.add('just-toggled');
    await onChange(next);
  };

  el.addEventListener('click', () => {
    void toggle();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    void toggle();
  });
}
