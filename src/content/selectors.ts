/**
 * NAI DOM 셀렉터 레지스트리.
 *
 * styled-components 해시 클래스(sc-xxx, css-xxx)는 빌드마다 바뀌므로 절대 쓰지 않고,
 * 의미 있는 클래스명 / aria-label / 텍스트 매칭으로 노드를 찾습니다.
 *
 * 자세한 분석: docs/04-nai-dom-notes.md
 */

/** 화면에 보이는 노드만 (display:none 제외, 모바일 트레이 회피) */
export function pickVisible<T extends HTMLElement = HTMLElement>(sel: string): T | null {
  for (const el of Array.from(document.querySelectorAll<T>(sel))) {
    if ((el as HTMLElement).offsetParent !== null) return el;
  }
  return null;
}

export const SEL = {
  // ProseMirror 에디터 — 캐릭터 추가 전후로 클래스명이 바뀜
  mainPrompt: '.prompt-input-box-prompt .ProseMirror, .prompt-input-box-base-prompt .ProseMirror',
  mainUC: '.prompt-input-box-undesired-content .ProseMirror',
  characterN: (n: number) =>
    `.character-prompt-input-${n} .prompt-input-box-character-prompts-${n} .ProseMirror`,

  // 컨테이너
  imageGenMain: '.image-gen-main',
  imageGenBody: '.image-gen-body',
  promptMain: '.image-gen-prompt-main',
  advancedSettings: '.image-gen-advanced-settings',

  // 결과 이미지
  resultImage: '.image-gen-main img.image-grid-image',
  displayGridTop: '.display-grid-top',
  displayGridBottom: '.display-grid-bottom',
  displayGridImages: '.display-grid-images',

  // react-select
  modelSelect: 'input[aria-label="Select the Model"]',
  samplerSelect: 'input[aria-label="Select a sampler"]',
  resolutionSelect: 'input[aria-label="Select a Resolution"]',

  // 토스트 (react-toastify)
  errorToast: '.Toastify__toast--error',

  // 모바일 트레이 회피용
  mobileTray: '.mobile-tray-contents',
} as const;

/** Generate 버튼 (텍스트 기반) */
export function findGenerateButton(): HTMLButtonElement | null {
  const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  return (
    btns.find((b) => /Generate/i.test(b.textContent ?? '') && /Anlas/i.test(b.textContent ?? '')) ??
    null
  );
}

/**
 * Anlas 잔량.
 *
 * 주의: NAI 페이지는 React 리렌더가 잦고 노드가 많아 매번 querySelectorAll 하면
 * 페이지 응답이 느려집니다. 한번 찾은 노드 쌍을 캐싱하고, 끊어지면 XPath로 한 번에 재탐색.
 */
let anlasCache: { label: Element; sibling: Element } | null = null;

export function readAnlas(): number | null {
  if (anlasCache && !anlasCache.label.isConnected) anlasCache = null;

  if (!anlasCache) {
    // "Anlas:" 텍스트는 display:contents div 안의 SPAN에 있음.
    // 따라서 span 부모(display:contents div) → nextElementSibling(값 div) → span 순으로 탐색.
    const xpaths = [
      "//span[normalize-space(text())='Anlas:']/..",
      "//*[normalize-space(text())='Anlas:']/..",
    ];
    for (const xpath of xpaths) {
      const r = document.evaluate(xpath, document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const labelParent = r.singleNodeValue as Element | null;
      const valueContainer = labelParent?.nextElementSibling ?? null;
      const label = labelParent?.querySelector('span') ?? null;
      const sibling = valueContainer?.querySelector('span') ?? valueContainer;
      if (label && sibling) {
        anlasCache = { label, sibling };
        break;
      }
    }
  }
  if (!anlasCache) return null;

  const text = anlasCache.sibling.textContent?.replace(/[^\d]/g, '');
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** 라벨 텍스트로 인접한 number input 찾기 (Steps/Guidance 등) */
export function findNumberInputByLabel(label: string): HTMLInputElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
  for (const el of all) {
    if (el.textContent?.trim() === label && el.children.length === 0) {
      const section = el.closest('div')?.parentElement;
      const input = section?.querySelector<HTMLInputElement>('input[type="number"]');
      if (input) return input;
    }
  }
  return null;
}

/** 이미지 결과의 Download Image 버튼 (tooltip 텍스트가 "Download Image") */
export function findDownloadButton(): HTMLButtonElement | null {
  // display-grid-bottom 의 3번째 버튼이 Download Image (실측). tooltip은 hover에서만 나오므로
  // 위치 기반 + 4개 중 3번째 휴리스틱.
  const wrap = document.querySelector(SEL.displayGridBottom);
  if (!wrap) return null;
  const btns = Array.from(wrap.querySelectorAll<HTMLButtonElement>('button'));
  return btns[2] ?? null;
}

/**
 * Seed 버튼 (텍스트가 "N/A" 또는 숫자인 버튼).
 * 위치: 'Seed' 라벨 옆 버튼. XPath로 한 번에.
 */
let seedButtonCache: HTMLButtonElement | null = null;
export function findSeedButton(): HTMLButtonElement | null {
  if (seedButtonCache && !seedButtonCache.isConnected) seedButtonCache = null;
  if (seedButtonCache) return seedButtonCache;
  const r = document.evaluate(
    "//span[normalize-space(text())='Seed']/following-sibling::button[1]",
    document.body,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null,
  );
  const btn = (r.singleNodeValue as HTMLButtonElement | null) ?? null;
  if (btn) seedButtonCache = btn;
  return btn;
}

/** 현재 NAI 시드 표시값 ("N/A" or "1234567890") */
export function readSeedDisplay(): string | null {
  const btn = findSeedButton();
  return btn?.textContent?.trim() ?? null;
}
