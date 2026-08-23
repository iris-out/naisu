/**
 * 세그먼트 토글 (슬라이딩 인디케이터).
 *
 * 컨테이너에 `--seg-i`(선택된 버튼 인덱스)를 세팅하면 CSS가 인디케이터를 그만큼 이동시킨다.
 * 반환값으로 값 기준 활성화 함수를 돌려줘서, 스토리지에서 읽어온 초기값을 클릭 없이도 반영할 수 있다.
 *
 * 접근성: 컨테이너는 radiogroup, 각 버튼은 radio로 동작해야 스크린리더가 "저장 방식:
 * 하드클린/클린/원본/둘 다" 중 무엇이 선택돼 있는지 읽을 수 있다. 로빙 tabindex(선택된
 * 버튼만 tabindex=0)로 ←/→ 방향키 이동을 지원한다.
 */
export function bindSeg(
  container: HTMLElement,
  initial: string,
  onChange: (v: string) => unknown,
): (v: string) => void {
  if (!container.hasAttribute('role')) container.setAttribute('role', 'radiogroup');

  const btns = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
  btns.forEach((b) => b.setAttribute('role', 'radio'));

  const activate = (v: string) => {
    btns.forEach((b) => {
      const isOn = b.dataset.v === v;
      b.classList.toggle('on', isOn);
      b.setAttribute('aria-checked', String(isOn));
      b.tabIndex = isOn ? 0 : -1;
    });
    const idx = Math.max(0, btns.findIndex((b) => b.dataset.v === v));
    container.style.setProperty('--seg-i', String(idx));
  };

  const selectByIndex = (idx: number) => {
    const b = btns[idx];
    if (!b) return;
    const v = b.dataset.v!;
    activate(v);
    b.focus();
    void onChange(v);
  };

  btns.forEach((b, i) => {
    b.addEventListener('click', () => {
      const v = b.dataset.v!;
      activate(v);
      void onChange(v);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        selectByIndex((i + 1) % btns.length);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        selectByIndex((i - 1 + btns.length) % btns.length);
      }
    });
  });

  activate(initial);
  return activate;
}
