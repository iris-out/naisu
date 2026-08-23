/**
 * 되돌릴 수 없는 동작용 "두 번 클릭" 확인 버튼.
 * 3초 안에 다시 누르지 않으면 원래 상태로 돌아간다.
 */

const CONFIRM_WINDOW_MS = 3000;

export function makeConfirmBtn(
  btn: HTMLButtonElement,
  action: () => Promise<void>,
  confirmText: string,
): void {
  let timer: number | undefined;
  btn.addEventListener('click', async () => {
    if (btn.dataset.confirm === '1') {
      clearTimeout(timer);
      btn.dataset.confirm = '0';
      btn.classList.remove('danger');
      btn.textContent = btn.dataset.original!;
      await action();
      return;
    }
    btn.dataset.original = btn.textContent ?? '';
    btn.dataset.confirm = '1';
    btn.classList.add('danger');
    btn.textContent = confirmText;
    timer = window.setTimeout(() => {
      btn.dataset.confirm = '0';
      btn.classList.remove('danger');
      btn.textContent = btn.dataset.original!;
    }, CONFIRM_WINDOW_MS);
  });
}
