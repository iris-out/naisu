/**
 * NAI 페이지(React + ProseMirror + react-select) 조작 헬퍼.
 */

/**
 * ProseMirror에 텍스트 주입 (전체 치환).
 *
 * ⚠ `document.execCommand`는 **지금 포커스된** 편집기에 쓴다. 대상에 포커스가 실제로
 * 옮겨가지 않았는데(탭 뒤에 숨어 있거나 display:none) 그대로 실행하면 엉뚱한 편집기에
 * 내용이 들어간다 — 2026-08-24 실측: 이력의 UC를 채우려다 **메인 프롬프트가 UC 내용으로
 * 덮이는** 버그가 났다. 그래서 포커스가 실제로 갔는지, 쓰고 나서 내용이 반영됐는지
 * 두 번 확인하고 실패를 호출자에게 돌려준다.
 *
 * @returns 실제로 주입에 성공했으면 true
 */
export function pmSetText(el: HTMLElement, text: string): boolean {
  el.focus();
  const active = document.activeElement;
  if (active !== el && !el.contains(active)) {
    console.warn(
      '[naisu] pmSetText: 대상 편집기에 포커스가 가지 않아 입력을 건너뜁니다 ' +
        '(숨겨진 탭일 수 있음). 엉뚱한 곳에 쓰지 않도록 중단합니다.',
      el,
    );
    return false;
  }

  // selectAll/delete 후 insertText — execCommand는 deprecated지만 PM이 여전히 처리한다
  document.execCommand('selectAll');
  document.execCommand('delete');
  document.execCommand('insertText', false, text);

  // 반영 확인 — PM이 입력을 거부했거나 다른 곳에 들어갔을 수 있다
  const got = (el.textContent ?? '').trim();
  const want = text.trim();
  if (want && !got.startsWith(want.slice(0, Math.min(24, want.length)))) {
    console.warn(
      `[naisu] pmSetText: 입력 후 내용이 기대와 다릅니다 (기대 "${want.slice(0, 40)}…", 실제 "${got.slice(0, 40)}…")`,
    );
    return false;
  }
  return true;
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
 * 시드 무작위화 시도 결과.
 *
 * 예전에는 boolean이었고 판단 기준이 `textContent === 'N/A'` 하나뿐이었다. NAI가 시드
 * 표시를 아이콘으로 바꾼 뒤로는 이미 랜덤 상태인데도 계속 false가 나왔고, 러너가 그걸
 * 치명적 오류로 처리해서 **배치 전체가 0장으로 죽는** 버그가 됐다(2026-08-23 보고).
 *
 * 그래서 "확인 못 함"과 "고정 시드가 확실함"을 구분한다 — 전자는 경고 후 진행,
 * 후자만 중단한다. 같은 이미지가 반복 생성되는 걸 막자는 원래 의도는 후자에서 지켜진다.
 */
export type SeedRandomizeResult =
  /** 표시값에 숫자가 없음 = 이미 자동/랜덤 */
  | 'already-random'
  /** 고정 숫자였는데 지워서 랜덤으로 바꿨음 */
  | 'randomized'
  /** 지웠는데도 여전히 고정 숫자 — 그대로 두면 같은 이미지가 반복된다 */
  | 'still-fixed'
  /** 시드 UI 자체를 못 찾음 — 판단 불가 */
  | 'unknown';

/** 표시 문자열에 숫자가 하나도 없으면 고정 시드가 아니다(N/A, 빈 값, 아이콘 전용 등). */
function looksRandom(text: string | null | undefined): boolean {
  return !/\d/.test((text ?? '').trim());
}

/** 실패 원인을 추적할 수 있게 시드 영역 주변 DOM을 요약해 남긴다. */
function describeSeedArea(seedBtn: HTMLButtonElement): string {
  const parent = seedBtn.parentElement;
  return [
    `button.text="${seedBtn.textContent?.trim() ?? ''}"`,
    `button.aria-label="${seedBtn.getAttribute('aria-label') ?? ''}"`,
    `button.title="${seedBtn.title}"`,
    `button.outerHTML=${seedBtn.outerHTML.slice(0, 300)}`,
    `parent.text="${parent?.textContent?.trim().slice(0, 120) ?? ''}"`,
  ].join(' | ');
}

/**
 * NAI 시드 필드를 자동(랜덤)으로 만든다.
 * - 표시값에 숫자가 없으면 이미 랜덤이므로 아무것도 하지 않는다
 * - 고정 숫자면 버튼을 눌러 나타나는 input을 비우고 blur
 */
export async function ensureRandomSeed(seedBtn: HTMLButtonElement): Promise<SeedRandomizeResult> {
  const before = seedBtn.textContent;
  if (looksRandom(before)) return 'already-random';

  seedBtn.click();
  await new Promise((r) => setTimeout(r, 80));
  const active = document.activeElement as HTMLElement | null;
  const inp =
    active instanceof HTMLInputElement
      ? active
      : document.querySelector<HTMLInputElement>(
          'input[type="number"]:not([readonly]), input[type="text"]:not([readonly])',
        );
  if (!inp) {
    console.warn(
      `[naisu] ensureRandomSeed: 시드 입력란을 찾지 못했습니다 — ${describeSeedArea(seedBtn)}`,
    );
    return 'unknown';
  }

  setReactInputValue(inp, '');
  inp.blur();
  await new Promise((r) => setTimeout(r, 80));

  const after = seedBtn.textContent;
  if (looksRandom(after)) return 'randomized';

  console.warn(
    `[naisu] ensureRandomSeed: 지운 뒤에도 시드가 고정으로 보입니다 (before="${before?.trim()}" after="${after?.trim()}") — ${describeSeedArea(seedBtn)}`,
  );
  return 'still-fixed';
}

/**
 * blob URL → Uint8Array. 하드클린/클린이 실패하는 원인 중 하나로 "애초에 유효한 이미지
 * 바이트를 못 받아왔다"(blob URL이 이미 revoke됐거나 레이스)는 가능성이 있어서, 이
 * 단계에서 실제로 뭘 받았는지 페이지 콘솔에 남긴다.
 */
/**
 * 시드를 NAI 입력란에 되돌려 넣는다 — 결과 줄의 "이 시드로 다시".
 *
 * ensureRandomSeed()와 정확히 대칭인 동작이다. 시드 버튼을 누르면 입력란이 열리고,
 * 거기에 값을 써 넣은 뒤 blur하면 NAI가 고정 시드로 받아들인다. React 제어형 입력이라
 * 네이티브 setter를 우회하는 setReactInputValue를 반드시 거쳐야 리렌더에 반영된다.
 *
 * @returns 성공하면 true. 실패는 조용히 삼키지 않고 console.warn + false.
 */
export async function setSeedValue(seedBtn: HTMLButtonElement, seed: number): Promise<boolean> {
  seedBtn.click();
  await new Promise((r) => setTimeout(r, 80));
  const active = document.activeElement as HTMLElement | null;
  const inp =
    active instanceof HTMLInputElement
      ? active
      : document.querySelector<HTMLInputElement>(
          'input[type="number"]:not([readonly]), input[type="text"]:not([readonly])',
        );
  if (!inp) {
    console.warn(`[naisu] setSeedValue: 시드 입력란을 찾지 못했습니다 — ${describeSeedArea(seedBtn)}`);
    return false;
  }
  setReactInputValue(inp, String(seed));
  inp.blur();
  await new Promise((r) => setTimeout(r, 80));
  const after = seedBtn.textContent?.trim() ?? '';
  if (!after.includes(String(seed))) {
    console.warn(
      `[naisu] setSeedValue: 값을 넣었지만 시드 표시가 "${after}"입니다 (기대: ${seed}) — NAI가 값을 거부했을 수 있습니다`,
    );
    return false;
  }
  return true;
}

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
