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
  displayGridBottom: '.display-grid-bottom',

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

/**
 * 현재 화면에 크게 표시된(선택된) 결과 이미지.
 *
 * NAI의 결과 그리드는 "메인 프리뷰 하나 + 썸네일들"이 서로 다른 컴포넌트가 아니다.
 * 배치/히스토리의 이미지들이 전부 같은 그리드 셀 컴포넌트(`img.image-grid-image`)로
 * 렌더링되고, 그중 "선택된" 셀만 부모가 계산한 크기를 크게 줘서 커 보일 뿐이다.
 * 그 크기 배정은 애니메이션되므로(Framer Motion), 렌더 크기 비교("가장 큰 이미지")로
 * 추론하면 전환 도중이거나 History 패널이 같은 클래스를 재사용하는 경우 엉뚱한
 * 이미지가 걸릴 수 있다 — 실제로 선택된 것 바로 옆 이미지가 저장되는 버그로 나타났다.
 *
 * 그래서 클래스/크기로 추론하는 대신, 화면 중앙(캔버스 중앙)에 실제로 그려진 요소가
 * 뭔지 브라우저에게 직접 물어본다(`elementsFromPoint`). 사용자가 보고 있는 자리를
 * 픽셀 단위로 히트테스트하는 것이라 DOM 구조·애니메이션·클래스 재사용에 흔들리지 않는다.
 */
export function findMainImage(): HTMLImageElement | null {
  const hit = hitTestMainImage();
  if (hit) return hit;

  // 폴백 — 캔버스가 패닝/줌되어 중앙에 이미지가 없는 등 히트테스트가 실패한 경우
  const candidates = Array.from(document.querySelectorAll<HTMLImageElement>(SEL.resultImage)).filter(
    (el) => el.src.startsWith('blob:') && el.offsetParent !== null,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, cur) =>
    cur.offsetWidth * cur.offsetHeight > best.offsetWidth * best.offsetHeight ? cur : best,
  );
}

/**
 * History 사이드바 카드도 메인 그리드와 같은 `img.image-grid-image` 컴포넌트를 재사용해서
 * 섞여 들어올 수 있다(2026-08-21 실측: `.display-grid-images`도 `.image-gen-output-region`도
 * 컨테이너 클래스로는 못 걸러냈음 — 매칭 6장 = 메인 그리드 4 + History 카드 2). 컨테이너
 * 클래스 대신 **렌더링 크기**로 구분한다 — 메인 캔버스의 그리드 타일은 크게 표시되고
 * History 카드 썸네일은 훨씬 작게 표시되므로(스크린샷 실측 기준 면적 비율 10배 이상 차이),
 * 가장 큰 이미지 대비 절반 미만인 것들을 히스토리 썸네일로 간주해 제외한다. 이 방식은 NAI가
 * 클래스명/DOM 구조를 바꿔도(둘 다 이미 한 번씩 배신했다) "메인이 훨씬 크게 보인다"는 UI
 * 관례 자체는 잘 안 바뀔 거라는 가정에 기댄다.
 */
function filterToLargestCluster(imgs: HTMLImageElement[]): HTMLImageElement[] {
  if (imgs.length === 0) return imgs;
  const rects = imgs.map((img) => img.getBoundingClientRect());
  const maxArea = Math.max(...rects.map((r) => r.width * r.height));
  return imgs.filter((_, i) => rects[i].width * rects[i].height >= maxArea * 0.5);
}

/** 방금 생성된 그리드의 이미지 전체(NAI가 Generate 한 번에 만들 수 있는 최대치까지). */
export function findGridImages(): HTMLImageElement[] {
  const seen = new Set<string>();
  const candidates = Array.from(document.querySelectorAll<HTMLImageElement>(SEL.resultImage)).filter((img) => {
    if (!img.src.startsWith('blob:') || seen.has(img.src) || img.offsetParent === null) return false;
    if (!(img.complete && img.naturalWidth >= 256)) return false;
    seen.add(img.src);
    return true;
  });
  return filterToLargestCluster(candidates);
}

/**
 * 새로 나타난 이미지 목록에서 메인 그리드에 속하지 않는 것(History 사이드바에 새로 생긴
 * 카드 등)을 걸러낸다. 자동 배치 러너가 `waitForNewImages()`로 모은 "새 이미지들" 중에는
 * 방금 생성한 결과가 History에도 새 카드로 추가되며 새 blob src를 얻는 경우가 섞여
 * 들어올 수 있어서(=knownSrcs diff만으론 못 거름), `findGridImages()`와 같은 크기 기반
 * 휴리스틱을 재사용한다.
 */
export function filterMainGridImages(imgs: HTMLImageElement[]): HTMLImageElement[] {
  return filterToLargestCluster(imgs);
}

function hitTestMainImage(): HTMLImageElement | null {
  const container =
    document.querySelector<HTMLElement>(SEL.imageGenBody) ??
    document.querySelector<HTMLElement>(SEL.imageGenMain);
  if (!container) return null;

  const rect = container.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  // elementFromPoint(최상단 하나만)은 hover 툴바 같은 투명 오버레이에 가려질 수 있으니
  // z-순서로 쌓인 요소들을 전부 훑어 첫 번째 blob 이미지를 찾는다.
  for (const el of document.elementsFromPoint(cx, cy)) {
    if (el instanceof HTMLImageElement && el.src.startsWith('blob:')) return el;
  }
  return null;
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
