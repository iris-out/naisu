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

/** 새 결과 이미지(들)가 등장할 때까지 대기 */
export interface WaitOptions {
  timeoutMs?: number;
  /** 이미지가 보이는 컨테이너 (기본 .image-gen-main) */
  container?: HTMLElement | Document;
  /** 이전에 본 이미지 src 집합 - 새로 등장한 것만 받아내려고 */
  knownSrcs?: Set<string>;
  /**
   * 새 이미지가 처음 감지된 뒤, 같은 생성 요청의 나머지 그리드 이미지(NAI는 한 번에
   * 최대 4장까지 동시 생성 가능)가 마저 로드될 시간을 얼마나 더 기다릴지.
   */
  settleMs?: number;
}

/**
 * NAI는 Generate 한 번으로 1~4장을 그리드로 한꺼번에 만들 수 있다. 첫 번째 새 이미지가
 * 뜨는 순간 바로 resolve하면 나머지 그리드 셀은 아직 로딩 중이라 놓치므로, 첫 감지 후
 * `settleMs`만큼 더 기다렸다가 그 시점까지 새로 나타난 이미지를 전부 모아서 반환한다.
 * knownSrcs로 "새 것"만 걸러내므로 히스토리 패널이 같은 클래스를 재사용해도 안전하다.
 */
export function waitForNewImages(
  selector: string,
  options: WaitOptions = {},
): Promise<HTMLImageElement[]> {
  const {
    timeoutMs = 60_000,
    container = document,
    knownSrcs = new Set<string>(),
    settleMs = 700,
  } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    let settleTimer: number | undefined;
    const obs = new MutationObserver(() => check());
    let pollTimer: number | undefined;

    function collectReady(): HTMLImageElement[] {
      const seen = new Set<string>();
      return Array.from(container.querySelectorAll<HTMLImageElement>(selector)).filter((img) => {
        if (!img.src || knownSrcs.has(img.src) || seen.has(img.src)) return false;
        if (!(img.complete && img.naturalWidth >= 256)) return false;
        seen.add(img.src);
        return true;
      });
    }

    function finish() {
      if (settled) return;
      settled = true;
      obs.disconnect();
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      resolve(collectReady());
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      obs.disconnect();
      if (pollTimer) clearInterval(pollTimer);
      if (settleTimer) clearTimeout(settleTimer);
      reject(err);
    }

    function check(): void {
      if (settled || settleTimer !== undefined) return;
      if (collectReady().length > 0) {
        // 그리드의 나머지 셀도 마저 로드되도록 여기서 바로 resolve하지 않고 잠깐 더 기다린다
        settleTimer = window.setTimeout(finish, settleMs);
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

/**
 * blob URL → Uint8Array. 하드클린/클린이 실패하는 원인 중 하나로 "애초에 유효한 이미지
 * 바이트를 못 받아왔다"(blob URL이 이미 revoke됐거나 레이스)는 가능성이 있어서, 이
 * 단계에서 실제로 뭘 받았는지 페이지 콘솔에 남긴다.
 */
export async function blobUrlToBytes(url: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error(`[naisu] blobUrlToBytes: fetch 자체가 실패함 url=${url}`, e);
    throw e;
  }
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  console.log(
    `[naisu] blobUrlToBytes: url=${url} fetchOk=${res.ok} status=${res.status} blobType="${blob.type}" blobSize=${blob.size} bytesLength=${bytes.length}`,
  );
  return bytes;
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
