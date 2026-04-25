/**
 * NAI 페이지(React + ProseMirror + react-select) 조작 헬퍼.
 */

/** ProseMirror에 텍스트 주입 (전체 치환) */
export function pmSetText(el: HTMLElement, text: string): void {
  el.focus();
  // selectAll/delete 후 insertText — execCommand는 deprecated지만 PM이 여전히 처리
  document.execCommand('selectAll');
  document.execCommand('delete');
  document.execCommand('insertText', false, text);
}

/** React 제어형 input/number/text 에 값 주입 (네이티브 setter 우회) */
export function setReactInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  proto?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 새 결과 이미지가 등장할 때까지 대기 */
export interface WaitOptions {
  timeoutMs?: number;
  /** 이미지가 보이는 컨테이너 (기본 .image-gen-main) */
  container?: HTMLElement | Document;
  /** 이전에 본 이미지 src 집합 - 새로 등장한 것만 받아내려고 */
  knownSrcs?: Set<string>;
}

export function waitForNewImage(
  selector: string,
  options: WaitOptions = {},
): Promise<HTMLImageElement> {
  const {
    timeoutMs = 60_000,
    container = document,
    knownSrcs = new Set<string>(),
  } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    const obs = new MutationObserver(() => check());
    let pollTimer: number | undefined;

    function done(img: HTMLImageElement) {
      if (settled) return;
      settled = true;
      obs.disconnect();
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      resolve(img);
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      obs.disconnect();
      if (pollTimer) clearInterval(pollTimer);
      reject(err);
    }

    function check(): void {
      if (settled) return;
      const imgs = Array.from(container.querySelectorAll<HTMLImageElement>(selector));
      for (const img of imgs) {
        if (!img.src || knownSrcs.has(img.src)) continue;
        // src는 새 것이지만 아직 로딩 중일 수 있음 → load 이벤트로 대기
        if (img.complete && img.naturalWidth >= 256) {
          done(img);
          return;
        }
        const onload = () => {
          img.removeEventListener('load', onload);
          if (img.naturalWidth >= 256) done(img);
        };
        img.addEventListener('load', onload);
      }
    }

    obs.observe(container instanceof Document ? container.body : container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });

    // attribute mutation이 fire 안 되는 케이스 보강 — 500ms 폴링
    pollTimer = window.setInterval(check, 500);

    check(); // 즉시 한 번

    const timer = setTimeout(() => fail(new Error('이미지 대기 시간 초과')), timeoutMs);
  });
}

/**
 * NAI 시드 필드를 N/A(자동 랜덤)로 만든다.
 * - 이미 N/A면 아무것도 안 함
 * - 숫자가 들어있으면 버튼 클릭 → 나타나는 input 비워서 blur
 * - 실패 시 false 반환 (사용자에게 안내 가능)
 */
export async function ensureRandomSeed(seedBtn: HTMLButtonElement): Promise<boolean> {
  if (seedBtn.textContent?.trim() === 'N/A') return true;
  seedBtn.click();
  await new Promise((r) => setTimeout(r, 80));
  // 방금 열린 input 찾기 (focus 우선, fallback으로 number input)
  const inp =
    (document.activeElement as HTMLInputElement | null) ??
    document.querySelector<HTMLInputElement>('input[type="number"]:not([readonly]), input[type="text"]:not([readonly])');
  if (!inp || (inp.tagName !== 'INPUT')) return false;
  setReactInputValue(inp, '');
  inp.blur();
  // 변경이 적용되도록 잠깐 대기
  await new Promise((r) => setTimeout(r, 80));
  return seedBtn.textContent?.trim() === 'N/A';
}

/** blob URL → Uint8Array */
export async function blobUrlToBytes(url: string): Promise<Uint8Array> {
  const blob = await (await fetch(url)).blob();
  return new Uint8Array(await blob.arrayBuffer());
}

/** Uint8Array → base64 (service worker로 보낼 때 사용) */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

/** 탭 제목으로 생성 진행 감지 */
export function isGenerating(): boolean {
  return document.title.startsWith('◲');
}
