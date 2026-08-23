/**
 * NAI DOM 셀렉터 레지스트리.
 *
 * styled-components 해시 클래스(sc-xxx, css-xxx)는 빌드마다 바뀌므로 절대 쓰지 않고,
 * 의미 있는 클래스명 / aria-label / 텍스트 매칭으로 노드를 찾습니다.
 *
 * 자세한 분석: docs/04-nai-dom-notes.md
 */

import type { SelfCheckItem, SelfCheckResponse } from '../lib/messages';
import { pmSetText } from './dom-helpers';

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
 *
 * 2026-08-22 실측 추가 버그: `offsetParent !== null`은 `display:none`만 걸러낼 뿐 스크롤로
 * 화면 밖에 나간 요소는 그대로 통과시킨다. 한 장씩 생성하는 사용자한테서 "이전에 뽑은
 * 이미지까지 같이 다운로드된다"는 보고가 왔는데, 콘솔에서 직접 찍어보니 이전 생성 결과가
 * 새 결과와 거의 같은 크기(면적비 96%)로 화면 밖에(`inViewport:false`) 여전히 남아있었다
 * — 면적 기준만으로는 이 케이스를 못 걸러낸다. 그래서 **뷰포트 교차 여부**를 먼저 걸러낸
 * 뒤에 크기 클러스터링을 적용한다.
 */
function isInViewport(r: DOMRect): boolean {
  return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
}

function filterToLargestCluster(imgs: HTMLImageElement[]): HTMLImageElement[] {
  if (imgs.length === 0) return imgs;
  const onScreen = imgs.filter((img) => isInViewport(img.getBoundingClientRect()));
  if (onScreen.length === 0) return [];
  const rects = onScreen.map((img) => img.getBoundingClientRect());
  const maxArea = Math.max(...rects.map((r) => r.width * r.height));
  return onScreen.filter((_, i) => rects[i].width * rects[i].height >= maxArea * 0.5);
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

  // 2026-08-23 실측: 기존 XPath 하나만으로는 못 찾는 페이지 상태가 있다
  // (콘솔에서 //span[text()='Seed']/following-sibling::button[1] → null).
  // 못 찾으면 runner가 시드 무작위화를 통째로 건너뛰어 같은 이미지가 반복되므로,
  // 전략을 여러 개 두고 전부 실패했을 때만 null을 돌려준다.
  const strategies: Array<[string, () => HTMLButtonElement | null]> = [
    // ① 'Seed' span 바로 뒤 형제 버튼 (기존 구조)
    [
      "span[text()='Seed'] 다음 형제 button",
      () => xpathButton("//span[normalize-space(text())='Seed']/following-sibling::button[1]"),
    ],
    // ② 태그를 가리지 않고 'Seed' 텍스트 노드를 가진 요소의 조상 안에서 첫 버튼
    [
      "'Seed' 라벨의 부모 컨테이너 안 첫 button",
      () =>
        xpathButton(
          "//*[normalize-space(text())='Seed']/ancestor-or-self::*[position()<=3]//button[1]",
        ),
    ],
    // ③ aria-label에 seed가 들어간 버튼 (NAI가 접근성 라벨을 달아 둔 경우)
    [
      'button[aria-label*=seed]',
      () =>
        (document.querySelector<HTMLButtonElement>(
          'button[aria-label*="seed" i], button[title*="seed" i]',
        ) ?? null),
    ],
  ];

  for (const [label, fn] of strategies) {
    let btn: HTMLButtonElement | null = null;
    try {
      btn = fn();
    } catch (e) {
      console.warn(`[naisu] findSeedButton: 전략 "${label}" 실행 중 오류`, e);
      continue;
    }
    if (btn) {
      seedButtonCache = btn;
      return btn;
    }
  }

  console.warn(
    '[naisu] findSeedButton: 시드 버튼을 찾지 못했습니다 — 시드 무작위화를 건너뜁니다. ' +
      'NAI가 시드 UI 구조를 바꿨을 수 있습니다. 콘솔에서 ' +
      `document.evaluate("//*[normalize-space(text())='Seed']", document.body, null, 9, null).singleNodeValue ` +
      '를 실행해 구조를 확인해 주세요.',
  );
  return null;
}

function xpathButton(expr: string): HTMLButtonElement | null {
  const r = document.evaluate(expr, document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  const node = r.singleNodeValue;
  return node instanceof HTMLButtonElement ? node : null;
}

/** 현재 NAI 시드 표시값 ("N/A" or "1234567890") */
export function readSeedDisplay(): string | null {
  const btn = findSeedButton();
  return btn?.textContent?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// N06. 네거티브(UC)·캐릭터 슬롯 주입 헬퍼
//
// 이력은 이미 캐릭터 프롬프트를 저장하고 있지만(lib/storage.ts::Settings.characterPrompts),
// 지금까지는 아무도 SEL.mainUC / SEL.characterN을 실제로 쓰지 않아서 배치가 UC나 캐릭터
// 슬롯을 변형할 방법이 없었다. 여기서는 주입/읽기 함수만 만든다 — 배선(언제 호출할지)은
// 다른 작업의 몫.
// ---------------------------------------------------------------------------

/**
 * 화면에 보이는 UC(네거티브) ProseMirror에 텍스트를 주입한다.
 * 모바일 트레이 등 숨은 사본이 같이 매칭될 수 있어서 pickVisible로 걸러낸다.
 *
 * @returns 성공하면 true, UC 입력 노드를 못 찾으면 false(조용히 삼키지 않고 console.warn)
 */
export function setUcText(text: string): boolean {
  const el = pickVisible<HTMLElement>(SEL.mainUC);
  if (!el) {
    console.warn(`[naisu] setUcText: UC ProseMirror 노드를 찾지 못함 (SEL.mainUC="${SEL.mainUC}")`);
    return false;
  }
  return pmSetText(el, text);
}

/** 현재 UC(네거티브) 프롬프트 내용을 읽는다 (배치 전후 값 복원용). */
export function readUcText(): string | null {
  const el = pickVisible<HTMLElement>(SEL.mainUC);
  if (!el) {
    console.warn(`[naisu] readUcText: UC ProseMirror 노드를 찾지 못함 (SEL.mainUC="${SEL.mainUC}")`);
    return null;
  }
  return el.textContent ?? '';
}

/**
 * n번 캐릭터 슬롯의 프롬프트 ProseMirror에 텍스트를 주입한다.
 *
 * **인덱스는 0-based로 가정한다** — 즉 처음 추가한 캐릭터 슬롯이 `n=0`. NAI가
 * `character-prompt-input-${n}` 클래스를 배열을 `.map((c, i) => ...)`로 렌더링하며
 * 붙이는 흔한 React 패턴을 따른다는 가정이며, `SEL.characterN` 자체의 정의(단순
 * 템플릿 치환)만으로는 0-based/1-based 여부를 단정할 근거가 없다 — **실제 라이브
 * NAI 페이지에서 클래스명을 콘솔로 직접 찍어 확인한 적은 없다.** UI에 보이는
 * "Character 1" 같은 라벨과 오프셋이 다를 수 있으니, 배선하는 쪽에서 반드시
 * 아래 "검증" 절차로 실제 인덱스를 먼저 확인할 것.
 *
 * @param n 캐릭터 슬롯 인덱스 (0-based로 가정, 미검증)
 * @returns 성공하면 true, 해당 슬롯이 없으면 false
 */
export function setCharacterPrompt(n: number, text: string): boolean {
  const el = pickVisible<HTMLElement>(SEL.characterN(n));
  if (!el) {
    console.warn(
      `[naisu] setCharacterPrompt: ${n}번 캐릭터 슬롯을 찾지 못함 — 슬롯이 안 열려있거나 인덱스 규칙(0/1-based)이 다를 수 있음`,
    );
    return false;
  }
  return pmSetText(el, text);
}

/** 현재 열려 있는 캐릭터 슬롯 개수. */
export function countCharacterSlots(): number {
  const prefix = 'prompt-input-box-character-prompts-';
  const nodes = document.querySelectorAll<HTMLElement>(`[class*="${prefix}"]`);
  const indices = new Set<number>();
  nodes.forEach((el) => {
    const cls = Array.from(el.classList).find((c) => c.startsWith(prefix));
    if (!cls) return;
    const idx = Number(cls.slice(prefix.length));
    if (Number.isFinite(idx)) indices.add(idx);
  });
  return indices.size;
}

// ---------------------------------------------------------------------------
// N02. 셀렉터 자가진단
// ---------------------------------------------------------------------------

/** 노드 요약(태그 + 클래스 일부) — 자가진단 detail에 쓰임 */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList).slice(0, 3).join('.');
  return cls ? `<${tag} class="${cls}">` : `<${tag}>`;
}

/**
 * NAI DOM 셀렉터가 아직 유효한지 검사한다. 부작용 없음(읽기 전용 — 클릭/값 변경 금지).
 *
 * "배치를 돌려봐야 깨진 걸 안다"는 문제를 해결하려는 목적이라, 실패한 항목뿐 아니라
 * 성공한 항목도 detail에 실제로 찾은 값(태그/클래스/개수/Anlas 값 등)을 남겨서
 * 사용자 진단 정보로 그대로 쓸 수 있게 한다.
 */
export function runSelfCheck(): SelfCheckResponse {
  const items: SelfCheckItem[] = [];

  // 1) 프롬프트 입력 영역
  {
    const el = pickVisible<HTMLElement>(SEL.mainPrompt);
    items.push({
      key: 'mainPrompt',
      label: '프롬프트 입력 영역',
      ok: !!el,
      detail: el
        ? `찾음 — ${describeElement(el)}, 텍스트 길이=${el.textContent?.length ?? 0}`
        : `SEL.mainPrompt("${SEL.mainPrompt}") 매칭 노드 없음 — ProseMirror 클래스명이 바뀌었을 수 있음`,
    });
  }

  // 2) Generate 버튼
  {
    const btn = findGenerateButton();
    items.push({
      key: 'generateButton',
      label: 'Generate 버튼',
      ok: !!btn,
      detail: btn
        ? `찾음 — ${describeElement(btn)}, 텍스트="${(btn.textContent ?? '').trim().slice(0, 30)}", disabled=${btn.disabled}`
        : `"Generate"와 "Anlas" 문구를 동시에 포함한 button을 못 찾음 — 페이지 로딩 중이거나 버튼 문구가 바뀌었을 수 있음`,
    });
  }

  // 3) 시드 버튼
  {
    const btn = findSeedButton();
    items.push({
      key: 'seedButton',
      label: '시드 버튼',
      ok: !!btn,
      detail: btn
        ? `찾음 — ${describeElement(btn)}, 표시값="${(btn.textContent ?? '').trim()}"`
        : `"Seed" 라벨 옆 button을 XPath로 못 찾음 — 라벨 텍스트나 DOM 구조가 바뀌었을 수 있음`,
    });
  }

  // 4) Anlas 표시
  {
    const anlas = readAnlas();
    items.push({
      key: 'anlas',
      label: 'Anlas 표시',
      ok: anlas !== null,
      detail:
        anlas !== null
          ? `읽음 — ${anlas} Anlas`
          : `"Anlas:" 라벨을 XPath로 못 찾았거나 값 파싱 실패 — 잔량 확인 없이 배치를 돌리면 위험`,
    });
  }

  // 5) 결과 이미지 컨테이너
  {
    const imgs = findGridImages();
    items.push({
      key: 'resultImage',
      label: '결과 이미지 컨테이너',
      ok: imgs.length > 0,
      detail:
        imgs.length > 0
          ? `찾음 — ${imgs.length}장, 예: ${describeElement(imgs[0])} (${imgs[0].naturalWidth}x${imgs[0].naturalHeight})`
          : `SEL.resultImage("${SEL.resultImage}") 매칭 이미지 없음 — 아직 생성한 이미지가 없어서일 수도 있고(정상) 셀렉터가 깨졌을 수도 있음`,
    });
  }

  const okCount = items.filter((i) => i.ok).length;
  return { items, okCount, total: items.length };
}
