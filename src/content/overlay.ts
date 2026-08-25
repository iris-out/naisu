/**
 * NAISU 플로팅 패널 — NAI 페이지 우하단에 항상 표시.
 * 컴팩트 버전: 헤더(Anlas + 진행) + 1줄 컨트롤 + 로그.
 * 이미지 메타/다운로드 같은 액션은 팝업에서 처리.
 */

import { icon } from '../lib/icons';
import { readAnlas, parseAnlasCostFromGenerateButton } from './selectors';
import type { PanelLayout, PanelTheme } from '../lib/storage';
import {
  getTemplate,
  getSettings,
  setSettings,
  STORAGE_KEYS,
  isDisclaimerAccepted,
  acceptDisclaimer,
  getBatchCursor,
  clearBatchCursor,
} from '../lib/storage';
import { totalCount } from '../lib/prompt-variator';
import {
  closePopover,
  gridPickerContent,
  menuContent,
  mountPopover,
  openPopover,
  quickSettingsContent,
  saveMenuRows,
  unmountPopover,
  MENU_SEP,
  MODE_LABEL,
  type MenuRow,
} from './panel-popover';
import type { SaveOverride } from './panel-types';
import { trySendMessage } from '../lib/messages';

const ROOT_ID = 'naisu-root';
const FONT_STYLE_ID = 'naisu-fonts';

/**
 * 번들된 Pretendard를 NAI 페이지에 건다.
 *
 * 패널 CSS는 novelai.net 문서에 적용되므로 그 안의 url(/fonts/...)은 확장이 아니라
 * novelai.net/fonts/... 로 해석되어 전부 404가 난다(2026-08-23 실측). 그래서 폰트는
 * 확장 리소스를 가리키는 <link>로 따로 건다 — 경로가 stylesheet 자신을 기준으로 풀린다.
 */
function injectFonts(): void {
  if (document.getElementById(FONT_STYLE_ID)) return;
  // 예전에는 CSS 전문(53KB)을 번들에 문자열로 넣어 매 페이지마다 파싱했다.
  // <link>로 걸면 브라우저가 확장 리소스를 한 번 읽고 캐시하므로 content script가 가벼워진다.
  const link = document.createElement('link');
  link.id = FONT_STYLE_ID;
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('fonts/pretendard.css');
  document.head.appendChild(link);
}

// ---------------------------------------------------------------------------
// D01: 자동 다운로드 약관 동의 모달 마크업
//
// 인용문 출처: https://novelai.net/terms — Effective Date 2025년 12월 8일, 2026-08-22 확인.
// ⚠ 약관은 개정된다. 문구를 갱신할 때는 반드시 원문을 다시 확인하고,
//   storage.ts의 DISCLAIMER_VERSION을 함께 올려서 사용자에게 다시 동의를 받을 것.
//   부정확한 인용은 경고 모달을 오히려 사용자를 잘못 안내하는 방향으로 만든다 — 절대 기억으로 쓰지 말 것.
//
// 원래 슬롯을 4개(자동화 / 계정 책임 / 생성물 권리 / 요청 빈도)로 잡았으나, 요청 빈도·서버 부하를
// 다루는 별도 조항은 없고 §9.1.6의 "excessive strain" 문구가 그 역할을 겸하므로 3개로 합쳤다.
// ---------------------------------------------------------------------------
const DISCLAIMER_HTML = `
  <div class="naisu-disclaimer-overlay" hidden>
    <div class="naisu-disclaimer" role="dialog" aria-modal="true"
         aria-labelledby="naisu-disclaimer-title" aria-describedby="naisu-disclaimer-desc">
      <h2 id="naisu-disclaimer-title">자동 다운로드 이용 안내</h2>
      <div class="naisu-disclaimer-body" id="naisu-disclaimer-desc" tabindex="-1">
        <p>NAISU의 <strong>자동 배치 생성·다운로드</strong> 기능을 처음 실행하기 전에,
          아래 내용을 확인하고 동의해 주세요.</p>
        <p class="scope-note">
          <strong>적용 범위</strong> — 이 확인은 <strong>자동 배치 실행</strong>에만 적용됩니다.
          화면에 이미 떠 있는 이미지를 사용자가 직접 눌러 저장하는 <strong>수동 저장</strong>은
          브라우저의 우클릭 저장과 동등하게 취급되며 이 동의 대상이 아닙니다.
        </p>
        <h3>NovelAI 이용약관 관련 조항</h3>
        <ul class="tos-quotes">
          <li>
            <span class="tos-label">자동화 이용 · 서버 부하 &mdash; §9.1.6 Misconduct</span>
            <blockquote>&ldquo;you may not use of botnets or automated systems in the Services
              that disrespect the limitations provided by our Service or otherwise place
              excessive strain on our Services&rdquo;</blockquote>
            <p class="tos-why">약관이 자동화 자체를 금지하는 것이 아니라, <strong>서비스가 정한 제한을
              무시하거나 과도한 부하를 주는</strong> 방식을 금지합니다. NAISU의
              <strong>안전 설정 &gt; 생성 간격</strong>(기본 1.5초)을 낮추면 이 조항에 저촉될 수 있습니다.
              기본값보다 낮추지 마세요.</p>
          </li>
          <li>
            <span class="tos-label">계정 이용 책임 &mdash; §8.1 Account</span>
            <blockquote>&ldquo;You are responsible for all activity that occurs via your account
              even if that activity is not by you or is without your knowledge or consent.&rdquo;</blockquote>
            <p class="tos-why">이 확장이 당신의 계정으로 수행하는 모든 생성 요청의 책임은
              당신에게 있습니다.</p>
          </li>
          <li>
            <span class="tos-label">생성물의 권리 &mdash; §1.3 Ownership</span>
            <blockquote>&ldquo;You, whether a legal or physical entity, retain all rights and
              ownership of your Content. We do not claim any ownership rights to your Content.&rdquo;</blockquote>
            <p class="tos-why">생성한 이미지의 권리는 당신에게 있습니다. NAISU는 이미지를
              어디에도 전송하지 않고, 저장은 전부 당신의 로컬 디스크에서 이루어집니다.</p>
          </li>
        </ul>
        <p class="tos-link">
          <a href="https://novelai.net/terms" target="_blank" rel="noopener noreferrer">novelai.net/terms 원문 보기 ↗</a>
          <span class="tos-asof">인용 기준: 2025년 12월 8일자 약관 (2026-08-22 확인)</span>
        </p>
      </div>
      <label class="naisu-disclaimer-check">
        <input type="checkbox" class="disclaimer-cb">
        <span>위 내용을 확인했으며, 자동 배치 생성·다운로드 이용에 동의합니다.</span>
      </label>
      <div class="naisu-disclaimer-actions">
        <button type="button" class="ghost disclaimer-cancel">취소</button>
        <button type="button" class="pri disclaimer-accept" disabled>동의하고 계속</button>
      </div>
    </div>
  </div>
`;

export interface ToastApi {
  show(): void;
  hide(): void;
  setProgress(done: number, total: number, etaSec?: number): void;
  log(line: string, kind?: 'info' | 'good' | 'bad'): void;
  /** 로그 줄과 별개로, 놓치면 안 되는 메시지를 화면 상단에 배너로 띄운다 (스트리핑 실패 등). */
  alert(message: string, kind?: 'bad' | 'info'): void;
  setStatus(status: string): void;
  onPause(handler: () => void): void;
  onStop(handler: () => void): void;
  /** 사용자가 ▶ 자동으로 클릭. count 인자는 패널 입력란의 값 */
  onStart(handler: (count: number) => void): void;
  /**
   * 사용자가 수동 저장 버튼 클릭.
   * override는 ⭳ 옆 ▾ 메뉴에서 "이번 한 장만 원본으로" 같은 걸 골랐을 때만 채워진다.
   */
  onManualDownload(handler: (override?: SaveOverride) => Promise<void>): void;

  /** 끊긴 배치 이어하기 제안 배너 */
  onResume(handler: () => void): void;
}

let toastApi: ToastApi | null = null;
let panel: HTMLElement | null = null;

interface PanelEls {
  root: HTMLElement;
  alerts: HTMLElement;
  card: HTMLElement;
  toggle: HTMLButtonElement;
  body: HTMLElement;
  // 헤더 (접혔을 때도 보임)
  anlasMini: HTMLElement;
  toastLine: HTMLElement;
  progMini: HTMLElement;
  miniBar: HTMLElement;
  // 헤더 접힘 버튼
  btnHeaderAuto: HTMLButtonElement;
  btnHeaderDl: HTMLButtonElement;
  // 배치 (실행/일시정지/재개 통합 버튼 + 중지)
  btnStartPause: HTMLButtonElement;
  btnStop: HTMLButtonElement;
  countInput: HTMLInputElement;
  countHint: HTMLElement;
  // 수동
  btnManualDl: HTMLButtonElement;
  btnManualMenu: HTMLButtonElement;
  log: HTMLElement;
  // A안: 상태 칩 · 이어하기
  btnMore: HTMLButtonElement;
  chips: HTMLElement;
  chipMode: HTMLButtonElement;
  chipFolder: HTMLButtonElement;
  chipName: HTMLButtonElement;
  gear: HTMLButtonElement;
  resumeBar: HTMLElement;
  resumeText: HTMLElement;
  btnResumeGo: HTMLButtonElement;
  btnResumeDismiss: HTMLButtonElement;
}

let els: PanelEls | null = null;

let pauseHandler: (() => void) | null = null;
let stopHandler: (() => void) | null = null;
let startHandler: ((count: number) => void) | null = null;
let manualDlHandler: ((override?: SaveOverride) => Promise<void>) | null = null;
let resumeHandler: (() => void) | null = null;
let wasRunning = false;

// ---------------------------------------------------------------------------
// U02: 진단 로그 히스토리 + stripStatus.detail 가로채기
//
// stripStatus.detail(재현에 필요한 상세 정보)은 runner.ts/index.ts가 console.error로만
// 남긴다(오너십이 다른 레인 파일이라 직접 손댈 수 없음). 패널에는 짧은 message만 toast.log로
// 전달되므로, "진단 정보 복사" 버튼이 detail까지 담으려면 console.error를 얇게 감싸서 그
// 문자열만 가로채는 수밖에 없다 — 원래 콘솔 출력 동작은 그대로 유지한 채로.
// ---------------------------------------------------------------------------
const LOG_HISTORY_MAX = 200;
const DIAG_LOG_LINES = 20;
const STRIP_DETAIL_PREFIX = '[naisu] stripStatus 상세:';

const logHistory: string[] = [];
let lastStripDetail: string | null = null;

const _origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  if (args[0] === STRIP_DETAIL_PREFIX && typeof args[1] === 'string') {
    lastStripDetail = args[1];
  }
  _origConsoleError(...args);
};

// ---------------------------------------------------------------------------
// U08: 라이트/다크/시스템 테마
//
// Settings(lib/storage.ts)는 동결이라 새 필드를 추가할 수 없다. 테마는 패널 UI 전용 설정이고
// novelai.net 오리진에서만 의미가 있으므로 localStorage에 별도 보관한다.
// ---------------------------------------------------------------------------
let systemMql: MediaQueryList | null = null;
let currentTheme: PanelTheme = 'light';

/**
 * 패널 테마는 팝업에서 고른 값을 따른다(기본 라이트).
 * 패널에 전환 버튼을 두면 설정이 두 군데로 갈라져서, 모양 선택과 같은 자리(팝업)로 모았다.
 */
function applyTheme(): void {
  if (!els) return;
  if (!systemMql) {
    systemMql = window.matchMedia('(prefers-color-scheme: dark)');
    systemMql.addEventListener('change', applyTheme);
  }
  const isDark = currentTheme === 'dark' || (currentTheme === 'system' && systemMql.matches);
  els.root.classList.toggle('naisu-dark', isDark);
}

// ---------------------------------------------------------------------------
// U09: 패널 위치 — 화면 비율로 저장 + 가장 가까운 모서리로 스냅
// ---------------------------------------------------------------------------
type PanelCorner = 'tl' | 'tr' | 'bl' | 'br';
const CORNER_MARGIN = 16;

let currentPosRatio: { leftPct: number; topPct: number } | null = null;

function applyPanelPos(root: HTMLElement, left: number, top: number): void {
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  root.style.right = 'auto';
  root.style.bottom = 'auto';
}

function savePanelPos(left: number, top: number): void {
  currentPosRatio = { leftPct: left / window.innerWidth, topPct: top / window.innerHeight };
  void chrome.storage.local.set({ [STORAGE_KEYS.panelPos]: currentPosRatio });
}

function nearestCorner(centerX: number, centerY: number): PanelCorner {
  const h = centerX < window.innerWidth / 2 ? 'l' : 'r';
  const v = centerY < window.innerHeight / 2 ? 't' : 'b';
  return `${v}${h}` as PanelCorner;
}

function cornerPosition(corner: PanelCorner, width: number, height: number): { left: number; top: number } {
  const left = corner.endsWith('l') ? CORNER_MARGIN : window.innerWidth - width - CORNER_MARGIN;
  const top = corner.startsWith('t') ? CORNER_MARGIN : window.innerHeight - height - CORNER_MARGIN;
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

// ---------------------------------------------------------------------------
// P02: Anlas 폴링 간격 — 숨김/접힘이면 10초, 배치 실행 중이면 항상 2초
// ---------------------------------------------------------------------------
let watcherTimer: ReturnType<typeof setTimeout> | undefined;

function updateAnlasDisplay(): void {
  if (!els) return;
  const a = readAnlas();
  const v = els.anlasMini.querySelector('.v');
  if (v) v.textContent = a !== null ? a.toLocaleString() : '—';
}

function computeAnlasInterval(): number {
  if (!els) return 10_000;
  const running = els.card.classList.contains('running');
  if (running) return 2000;
  const idle = document.hidden || els.card.classList.contains('collapsed');
  return idle ? 10_000 : 2000;
}

function scheduleAnlasUpdate(): void {
  if (watcherTimer !== undefined) clearTimeout(watcherTimer);
  watcherTimer = setTimeout(() => {
    updateAnlasDisplay();
    scheduleAnlasUpdate();
  }, computeAnlasInterval());
}

// 탭이 다시 보이면 즉시 갱신하고 간격을 재계산한다 (숨김 상태에서 쌓인 지연을 바로 해소)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && els) {
    updateAnlasDisplay();
    scheduleAnlasUpdate();
  }
});

/**
 * 팝업에서 고른 패널 모양을 반영한다.
 * 레일 모드는 마크업을 바꾸지 않고 클래스 하나로 CSS 레이아웃만 전환한다 —
 * 두 모드가 같은 DOM을 쓰므로 이벤트 배선이나 상태가 갈라지지 않는다.
 */
async function applyPanelLayout(): Promise<void> {
  if (!els) return;
  const { panelLayout, panelTheme } = await getSettings();
  currentTheme = panelTheme;
  applyTheme();
  const layout: PanelLayout = panelLayout;
  const isRail = layout === 'rail';
  els.root.classList.toggle('rail', isRail);
  // 레일에는 접기 개념이 없다 — 카드에서 접어둔 채 전환해도 펼쳐진 상태로 시작한다
  if (isRail && els.card.classList.contains('collapsed')) {
    els.card.classList.remove('collapsed');
    els.toggle.innerHTML = icon('chevron_down', 14);
    els.toggle.setAttribute('aria-expanded', 'true');
  }
}

/**
 * 로그가 안 보이는 상태(패널을 접었거나 레일 모드)에서 새 줄이 찍히면,
 * 마지막 한 줄만 헤더 아래로 미끄러져 내려왔다가 2초 뒤 사라진다.
 * 배치가 도는 동안 아무 피드백이 없던 문제를, 패널을 펴게 만들지 않고 해결한다.
 *
 * 로그 상자에 이미 aria-live가 걸려 있어서 이 줄은 aria-hidden — 같은 내용을 두 번 읽지 않게.
 */
const TOAST_MS = 2000;
let toastTimer: number | undefined;

/**
 * 로그 상자가 지금 실제로 보이는가.
 *
 * ⚠ 예전에는 "카드 모드면 로그는 항상 보인다"고 가정하고 `return true`였다. A안에서 로그가
 *   **기본 숨김**(⋯ 메뉴로 켬)이 되면서 이 가정이 깨졌고, 그 결과 카드 모드에서
 *   토스트도 안 뜨고 로그도 안 보이는 **사각지대**가 생겼다 — 결과 줄이 안 만들어지는
 *   메시지("저장할 이미지 없음" 등)가 통째로 사라졌다(2026-08-24 실제 NAI에서 보고).
 *   클래스로 추론하지 말고 실제로 렌더됐는지를 본다: hidden / `:empty` / 레일 접힘이
 *   전부 offsetParent 하나로 판정된다.
 */
function isLogVisible(): boolean {
  if (!els) return false;
  if (els.card.classList.contains('collapsed')) return false;
  return els.log.offsetParent !== null;
}

function showToastLine(line: string, kind: 'info' | 'good' | 'bad'): void {
  if (!els) return;
  // 실패는 로그가 보이든 말든 항상 띄운다 — 흐르는 회색 로그 한 줄로는 놓치기 쉽고,
  // 사용자가 기대하는 것도 "눈에 확 들어오는" 알림이다.
  // 성공/정보는 로그가 이미 보이는 상황이면 중복이라 띄우지 않는다.
  if (kind !== 'bad' && isLogVisible()) return;
  const el = els.toastLine;
  el.textContent = line;
  el.dataset.kind = kind;
  el.hidden = false;
  // 연달아 찍힐 때 애니메이션이 다시 재생되도록 리플로우를 강제한다
  el.classList.remove('in');
  void el.offsetWidth;
  el.classList.add('in');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (!els) return;
    els.toastLine.classList.remove('in');
    els.toastLine.hidden = true;
    toastTimer = undefined;
  }, TOAST_MS);
}

function startWatchers(): void {
  updateAnlasDisplay();
  scheduleAnlasUpdate();
}

export function unmountPanel(): void {
  unmountPopover();
  panel?.remove();
  panel = null;
  els = null;
  toastApi = null;
  pauseHandler = null;
  stopHandler = null;
  startHandler = null;
  manualDlHandler = null;
  resumeHandler = null;
  wasRunning = false;
  if (watcherTimer !== undefined) {
    clearTimeout(watcherTimer);
    watcherTimer = undefined;
  }
  if (systemMql) {
    systemMql.removeEventListener('change', applyTheme);
    systemMql = null;
  }
  logHistory.length = 0;
}

export function mountPanel(forceTopLeft = false): void {
  if (panel) return;

  injectFonts();

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="naisu-alerts">
      <div class="np-toast" aria-hidden="true" hidden></div>
    </div>
    <div class="naisu-panel">
      <div class="np-h">
        <div class="brand">NAISU</div>
        <div class="np-h-btns">
          <button class="h-btn-auto" title="자동 다운로드 시작">${icon('play', 12)}<span class="btn-lbl">자동</span></button>
          <button class="h-btn-dl" title="현재 이미지 저장">${icon('download', 13)}<span class="btn-lbl">저장</span></button>
        </div>
        <div class="head-info">
          <span class="anlas-mini"><span class="k">Anlas</span><span class="v">—</span></span>
          <span class="prog-mini">대기 중</span>
        </div>
        <div class="np-h-actions">
          <button class="more" type="button" data-pop-anchor title="더보기" aria-label="더보기" aria-haspopup="menu">${icon('more', 14)}</button>
          <button class="toggle" type="button" title="접기" aria-expanded="true">${icon('chevron_down', 14)}</button>
        </div>
      </div>
      <div class="np-mini-bar"><span></span></div>
      <div class="np-b">
        <div class="np-chips">
          <button class="np-chip" type="button" data-chip="mode" data-pop-anchor aria-haspopup="dialog">
            <span class="k">저장</span><span class="v">—</span>
          </button>
          <button class="np-chip" type="button" data-chip="folder" data-pop-anchor aria-haspopup="dialog">
            <span class="k">폴더</span><span class="v">—</span>
          </button>
          <button class="np-chip" type="button" data-chip="name" data-pop-anchor aria-haspopup="dialog">
            <span class="k">이름</span><span class="v">—</span>
          </button>
          <button class="np-gear" type="button" data-chip="all" data-pop-anchor title="저장 설정" aria-label="저장 설정" aria-haspopup="dialog">${icon('sliders', 14)}</button>
        </div>
        <div class="np-row main-row">
          <input class="count" type="number" min="1" value="1" title="생성할 장수" aria-label="생성할 장수">
          <button class="pri" data-batch="startpause" data-action="start">${icon('play', 13)}<span class="btn-lbl">자동으로</span></button>
        </div>
        <div class="np-row save-row">
          <button class="dl" data-manual="dl" title="화면의 이미지를 지금 저장합니다">${icon('download', 13)}<span class="btn-lbl">이 이미지 저장</span></button>
          <button class="dl-more" data-manual="menu" data-pop-anchor title="이번 한 장만 다른 방식으로" aria-label="저장 방식 고르기" aria-haspopup="menu">${icon('chevron_down', 12)}</button>
          <button class="stop r" data-batch="stop" title="중단" disabled aria-label="중단">${icon('square', 13)}</button>
        </div>
        <div class="count-hint"></div>
        <div class="np-resume" hidden><span class="txt"></span><button class="go" type="button">이어하기</button><button class="dismiss" type="button" aria-label="닫기">✕</button></div>
        <div class="np-log log" role="log" aria-live="polite" aria-label="실행 로그"></div>
      </div>
    </div>
    ${DISCLAIMER_HTML}
  `;
  document.documentElement.appendChild(root);
  panel = root;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T;

  els = {
    root,
    alerts: $('.naisu-alerts'),
    card: $('.naisu-panel'),
    toggle: $('.toggle') as HTMLButtonElement,
    body: $('.np-b'),
    anlasMini: $('.anlas-mini'),
    toastLine: $('.np-toast'),
    progMini: $('.prog-mini'),
    miniBar: $('.np-mini-bar > span'),
    btnHeaderAuto: $('.h-btn-auto') as HTMLButtonElement,
    btnHeaderDl: $('.h-btn-dl') as HTMLButtonElement,
    btnStartPause: $('button[data-batch="startpause"]') as HTMLButtonElement,
    btnStop: $('button[data-batch="stop"]') as HTMLButtonElement,
    countInput: $('.count') as HTMLInputElement,
    countHint: $('.count-hint'),
    btnManualDl: $('button[data-manual="dl"]') as HTMLButtonElement,
    btnManualMenu: $('button[data-manual="menu"]') as HTMLButtonElement,
    log: $('.log'),
    btnMore: $('.more') as HTMLButtonElement,
    chips: $('.np-chips'),
    chipMode: $('[data-chip="mode"]') as HTMLButtonElement,
    chipFolder: $('[data-chip="folder"]') as HTMLButtonElement,
    chipName: $('[data-chip="name"]') as HTMLButtonElement,
    gear: $('.np-gear') as HTMLButtonElement,
    resumeBar: $('.np-resume'),
    resumeText: $('.np-resume .txt'),
    btnResumeGo: $('.np-resume .go') as HTMLButtonElement,
    btnResumeDismiss: $('.np-resume .dismiss') as HTMLButtonElement,
  };

  mountPopover(root);

  // 상태 칩 — 누르면 그 항목만 담긴 팝오버가 열린다
  const chipTargets: Array<[HTMLButtonElement, 'mode' | 'folder' | 'name' | 'all']> = [
    [els.chipMode, 'mode'],
    [els.chipFolder, 'folder'],
    [els.chipName, 'name'],
    [els.gear, 'all'],
  ];
  for (const [btn, field] of chipTargets) {
    btn.addEventListener('click', () => {
      openPopover(`chip:${field}`, btn, (body) => {
        void quickSettingsContent(body, field, () => void refreshChips());
      });
    });
  }

  // ⭳ 옆 ▾ — 이번 한 장만 다른 방식으로
  els.btnManualMenu.addEventListener('click', () => {
    openPopover('save-menu', els!.btnManualMenu, (body, close) => {
      void getSettings().then((s) => {
        menuContent(
          body,
          saveMenuRows(s.downloadMode, (override) => void manualDlHandler?.(override)),
          close,
        );
      });
    });
  });

  // ⋯ 더보기 — 자주 쓰지 않는 것들이 사는 곳(로그·진단·캐시 등)
  els.btnMore.addEventListener('click', () => {
    openPopover('more', els!.btnMore, (body, close) => {
      menuContent(body, buildMoreMenu(), close);
    });
  });

  els.btnResumeGo.addEventListener('click', () => {
    els!.resumeBar.hidden = true;
    resumeHandler?.();
  });
  els.btnResumeDismiss.addEventListener('click', () => {
    els!.resumeBar.hidden = true;
    void clearBatchCursor();
  });

  void refreshChips();
  void offerResumeIfPending();

  // 배치 컨트롤 (실행/일시정지/재개 통합)
  els.btnStartPause.addEventListener('click', () => {
    const action = els!.btnStartPause.dataset.action ?? 'start';
    if (action === 'start') {
      const n = Math.max(1, Number(els!.countInput.value) || 1);
      startHandler?.(n);
    } else {
      pauseHandler?.();
    }
  });
  els.btnStop.addEventListener('click', () => stopHandler?.());

  // 헤더 접힘 버튼 (패널 펼침 없이 동작)
  els.btnHeaderAuto.addEventListener('click', () => {
    const action = els!.btnHeaderAuto.dataset.action ?? 'start';
    if (action === 'start') {
      const n = Math.max(1, Number(els!.countInput.value) || 1);
      startHandler?.(n);
    } else {
      pauseHandler?.();
    }
  });
  els.btnHeaderDl.addEventListener('click', () => void manualDlHandler?.());

  // 수동 저장
  els.btnManualDl.addEventListener('click', () => void manualDlHandler?.());

  // B06: 장수 입력값 — 사용자가 직접 손댄 값은 Settings.panelCount에 저장해 템플릿이
  // 바뀌어도 유지한다. 템플릿 총량은 placeholder + 보조 문구로만 안내한다.
  void loadCountFromSettings();
  void refreshCountHint();
  let saveCountTimer: ReturnType<typeof setTimeout> | undefined;
  const flushCount = () => {
    if (saveCountTimer) {
      clearTimeout(saveCountTimer);
      saveCountTimer = undefined;
    }
    const n = Math.max(1, Number(els!.countInput.value) || 1);
    void setSettings({ panelCount: n });
  };
  els.countInput.addEventListener('input', () => {
    if (saveCountTimer) clearTimeout(saveCountTimer);
    saveCountTimer = setTimeout(flushCount, 400);
    void refreshCountHint(); // 예상 Anlas·시간이 입력을 따라 즉시 움직이게
  });
  els.countInput.addEventListener('blur', flushCount);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEYS.templates]) void refreshCountHint();
    if (changes[STORAGE_KEYS.settings]) {
      void loadCountFromSettings();
      // 팝업에서 저장 방식을 바꿔도 패널 칩이 즉시 따라가야 한다 — 두 곳이 어긋나면
      // 칩이 보여 주는 값을 믿을 수 없게 되고, 칩을 만든 이유가 없어진다.
      void refreshChips();
    }
  });

  // 접기 토글
  els.toggle.addEventListener('click', () => {
    closePopover(); // 접힌 패널 밖에 팝오버만 남아 떠 있는 상태를 막는다
    const collapsed = els!.card.classList.toggle('collapsed');
    els!.toggle.setAttribute('aria-expanded', String(!collapsed));
    els!.toggle.innerHTML = icon(collapsed ? 'chevron_up' : 'chevron_down', 14);
    scheduleAnlasUpdate(); // P02: 접힘 상태가 폴링 간격에 영향을 주므로 즉시 재계산
  });

  // U08: 패널 테마 — OS 다크 모드 설정을 그대로 따른다
  applyTheme();

  // 헤더 드래그
  enableDrag(root, $('.np-h'), forceTopLeft);

  // 패널 모양(기본 카드 / 아이콘 레일)
  void applyPanelLayout();
  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEYS.settings]) void applyPanelLayout();
  });

  // 이미지 존재 여부 + Anlas 폴링
  startWatchers();

  // D01: 약관 동의 모달 배선
  wireDisclaimerModal(root);

  // 토스트 API 노출 (runner가 사용)
  toastApi = {
    show: () => {
      // 패널은 항상 표시 상태 — 강제 펼침 없음 (사용자가 접은 상태 유지)
    },
    hide: () => {
      els!.card.classList.add('collapsed');
      els!.toggle.innerHTML = icon('chevron_up', 14);
    },
    setProgress: (done, total, etaSec) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      els!.miniBar.style.width = `${pct}%`;
      const etaTxt =
        etaSec !== undefined && etaSec > 0
          ? ` · 약 ${Math.floor(etaSec / 60)}분 ${Math.round(etaSec % 60)}초 남음`
          : '';
      els!.progMini.textContent = `${done}/${total} · ${pct}%${etaTxt}`;
    },
    log: (line, kind = 'info') => {
      showToastLine(line, kind);
      // 패널 로그와 별개로 항상 페이지 콘솔(F12)에도 남긴다 — SW 콘솔(chrome://extensions
      // → service worker)은 따로 열어야 보이는 별개 컨텍스트라, 일반 사용자가 캡처해서
      // 보내주기 쉬운 쪽은 이 페이지 콘솔이다.
      (kind === 'bad' ? console.error : kind === 'good' ? console.log : console.info)(`[naisu] ${line}`);
      const t = new Date();
      const ts = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
      const kindTag = kind === 'good' ? '✓ ' : kind === 'bad' ? '✕ ' : '';
      // U02: 진단 정보 복사에 쓸 평문 히스토리도 함께 보관
      logHistory.push(`[${ts}] ${kindTag}${line}`);
      if (logHistory.length > LOG_HISTORY_MAX) logHistory.shift();

      const div = document.createElement('div');
      const tag = kind === 'good' ? `<s>✓</s> ` : kind === 'bad' ? `<em>✕</em> ` : '';
      div.innerHTML = `<span class="t">[${ts}]</span> ${tag}${escapeHtml(line)}`;
      els!.log.appendChild(div);
      els!.log.scrollTop = els!.log.scrollHeight;
      // 너무 길면 오래된 줄 제거
      while (els!.log.childElementCount > 60) els!.log.firstElementChild?.remove();
      // 패널이 뷰포트 아래로 벗어나면 위로 슬라이드
      requestAnimationFrame(() => {
        if (!els) return;
        const rect = els.card.getBoundingClientRect();
        if (rect.bottom > window.innerHeight - 8) {
          const newTop = Math.max(8, window.innerHeight - 8 - rect.height);
          applyPanelPos(els.root, rect.left, newTop);
          savePanelPos(rect.left, newTop);
        }
      });
    },
    alert: (message, kind = 'bad') => showAlertBanner(message, kind),
    setStatus: (s) => {
      els!.progMini.textContent = s;
      const running = s === '실행 중' || s.startsWith('생성 ');
      const paused = s === '일시정지';
      const active = running || paused;
      els!.card.classList.toggle('running', active);
      els!.btnStop.disabled = !active;
      // 대기 → 실행으로 새로 진입할 때만 짧게 펄스 (상태 문자열이 바뀔 때마다 재생하지 않도록)
      if (running && !wasRunning) {
        els!.card.classList.remove('pulse');
        void els!.card.offsetWidth;
        els!.card.classList.add('pulse');
      }
      if (running !== wasRunning) scheduleAnlasUpdate(); // P02: 실행 상태 전환 시 폴링 간격 재계산
      wasRunning = running;
      // 통합 실행/일시정지/재개 버튼
      const spAction = running ? 'pause' : paused ? 'resume' : 'start';
      els!.btnStartPause.dataset.action = spAction;
      els!.btnStartPause.innerHTML =
        spAction === 'pause'
          ? `${icon('pause', 13)}<span class="btn-lbl">일시정지</span>`
          : spAction === 'resume'
            ? `${icon('play', 13)}<span class="btn-lbl">재개</span>`
            : `${icon('play', 13)}<span class="btn-lbl">자동으로</span>`;
      els!.btnStartPause.disabled = false;
      // 헤더 버튼 동기화 (접힘 상태 버튼)
      const hAction = running ? 'pause' : paused ? 'resume' : 'start';
      els!.btnHeaderAuto.dataset.action = hAction;
      els!.btnHeaderAuto.innerHTML =
        hAction === 'pause'
          ? icon('pause', 12)
          : hAction === 'resume'
            ? `${icon('play', 12)}<span class="btn-lbl">재개</span>`
            : `${icon('play', 12)}<span class="btn-lbl">자동</span>`;
      els!.btnHeaderAuto.title =
        hAction === 'pause' ? '일시정지' : hAction === 'resume' ? '재개' : '자동 제작 시작';
    },
    onPause: (h) => (pauseHandler = h),
    onStop: (h) => (stopHandler = h),
    onStart: (h) => (startHandler = h),
    onManualDownload: (h) => (manualDlHandler = h),
    onResume: (h) => (resumeHandler = h),
  };
}

export function getToast(): ToastApi {
  if (!toastApi) mountPanel();
  return toastApi!;
}

// ---------------------------------------------------------------------------
// A안: 상태 칩 · 더보기 메뉴 · 이어하기 제안
// ---------------------------------------------------------------------------

/** 칩에 현재 값을 채운다. 설정이 어디서 바뀌든(팝업·팝오버·다른 탭) 여기 한 곳으로 모인다. */
async function refreshChips(): Promise<void> {
  if (!els) return;
  const s = await getSettings();

  const set = (btn: HTMLButtonElement, value: string, title: string): void => {
    const v = btn.querySelector('.v');
    if (v) v.textContent = value;
    btn.title = title;
  };
  set(els.chipMode, MODE_LABEL[s.downloadMode], `저장 방식: ${MODE_LABEL[s.downloadMode]} — 눌러서 바꿉니다`);
  const folder = [s.downloadFolder, s.batchFolderTemplate].filter(Boolean).join('/');
  set(els.chipFolder, s.downloadFolder || '(기본)', `저장 폴더: ${folder || '(다운로드 폴더 바로 아래)'} — 눌러서 바꿉니다`);
  set(els.chipName, s.filenameTemplate, `파일 이름: ${s.filenameTemplate} — 눌러서 바꿉니다`);
}

/**
 * 그리드 선택 저장 팝오버를 띄우고 사용자가 고른 인덱스를 돌려준다.
 * 취소·Esc·바깥 클릭이면 null — 호출부(content/index.ts)는 그때 아무것도 저장하지 않는다.
 */
export function pickGridImages(items: Array<{ src: string; label: string }>): Promise<number[] | null> {
  return new Promise((resolve) => {
    if (!els) {
      resolve(null);
      return;
    }
    // close()는 확인 후에도 호출되므로, onClose가 확인 결과를 null로 덮어쓰지 않게 표시해 둔다.
    let confirmed = false;
    openPopover(
      'grid-pick',
      els.btnManualDl,
      (body, close) => {
        gridPickerContent(
          body,
          items,
          (indices) => {
            confirmed = true;
            close();
            resolve(indices);
          },
          close,
        );
      },
      () => {
        if (!confirmed) resolve(null);
      },
    );
  });
}

/** ⋯ 메뉴 구성 — 매번 새로 만든다(로그 표시 여부 등 상태가 라벨에 반영되어야 하므로). */
function buildMoreMenu(): MenuRow[] {
  const logVisible = els ? !els.log.hidden : false;
  return [
    {
      label: logVisible ? '로그 숨기기' : '로그 보기',
      iconName: 'scroll_text',
      hint: '원문 실행 로그',
      onPick: () => {
        if (!els) return;
        els.log.hidden = !els.log.hidden;
        els.log.classList.toggle('expanded', !els.log.hidden);
      },
    },
    {
      label: '진단 정보 복사',
      iconName: 'stethoscope',
      hint: '오류 문의용',
      onPick: () => void copyDiagnostics(),
    },
    MENU_SEP,
    {
      label: '설정 열기',
      iconName: 'sliders',
      hint: '전체 설정 화면',
      onPick: () => void trySendMessage('naisu.options.open'),
    },
  ];
}

/**
 * N07 연계 — 새로고침 등으로 끊긴 배치가 있으면 패널에서 바로 이어갈 수 있게 제안한다.
 * 지금까지 배치 커서는 저장만 되고 사용자에게 보이는 자리가 없었다.
 */
async function offerResumeIfPending(): Promise<void> {
  if (!els) return;
  const s = await getSettings();
  if (!s.offerResume) return;
  const cursor = await getBatchCursor();
  if (!cursor || cursor.nextIdx >= cursor.total) return;
  const why: Record<string, string> = {
    user: '사용자 중단',
    anlas: 'Anlas 부족',
    error: '오류',
    unload: '탭 종료·새로고침',
  };
  els.resumeText.textContent = `중단된 배치 ${cursor.nextIdx}/${cursor.total}장 (${why[cursor.reason] ?? cursor.reason})`;
  els.resumeBar.hidden = false;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const ALERT_AUTOHIDE_MS: Record<'bad' | 'info', number> = { bad: 15_000, info: 8_000 };
const ALERT_MAX_STACK = 4;

/** 로그 스크롤에 묻히면 안 되는 실패/경고를 화면 상단에 배너로 띄운다 (스트리핑 실패 등). */
function showAlertBanner(message: string, kind: 'bad' | 'info' = 'bad'): void {
  if (!els) return;
  const box = document.createElement('div');
  box.className = `naisu-alert ${kind}`;
  // A05: 실패(bad)는 즉시 끼어들어 알려야 하는 알림(role=alert), 정보(info)는 덜 급한 상태
  // 알림(role=status, 암묵적으로 aria-live=polite)으로 구분한다.
  box.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  box.innerHTML = `<span class="msg"></span><button class="close" title="닫기" aria-label="닫기">✕</button>`;
  box.querySelector('.msg')!.textContent = message; // XSS 방지 — 항상 textContent로 주입
  const close = () => box.remove();
  box.querySelector('.close')!.addEventListener('click', close);
  els.alerts.appendChild(box);
  // 이 컨테이너에는 토스트 pill도 함께 산다 — 배너만 세고 배너만 지운다.
  // (예전처럼 firstElementChild를 지우면 토스트 요소가 통째로 사라져 알림이 죽는다)
  const banners = els.alerts.querySelectorAll('.naisu-alert');
  for (let i = 0; i < banners.length - ALERT_MAX_STACK; i++) banners[i]?.remove();
  setTimeout(close, ALERT_AUTOHIDE_MS[kind]);
}

// ---------------------------------------------------------------------------
// B06: 패널 장수 입력값 — Settings.panelCount와 동기화
// ---------------------------------------------------------------------------

async function loadCountFromSettings(): Promise<void> {
  if (!els) return;
  if (document.activeElement === els.countInput) return; // 사용자 입력 중이면 무시
  const settings = await getSettings();
  els.countInput.value = String(Math.max(1, settings.panelCount));
}

/**
 * 장수 아래 보조 문구 — **실행 전 예상치**만 짧게 보여 준다.
 *
 * 예전에는 여기에 템플릿 전개 방식("시드만 변경 × 5 = 5장")과 단가를 못 읽었을 때의
 * "(어림)" 표시까지 다 넣었는데, 매번 읽게 되는 자리에 설명이 길게 깔려 시끄러웠다.
 * 템플릿 총량은 입력란 placeholder와 title(툴팁)에 그대로 남는다.
 *
 * Anlas 단가는 NAI가 Generate 버튼에 이미 계산해 둔 값을 그대로 읽는다(해상도·스텝·동시
 * 생성 장수가 전부 반영되어 있다). **못 읽으면 아예 표시하지 않는다** — 어림값을 숫자로
 * 보여 주면 사용자가 그걸 실제 비용으로 믿게 되고, 그 위에 세운 "Anlas 부족" 경고까지
 * 틀리게 된다(실제 화면에서 잔량이 충분한데도 부족 경고가 떴다).
 */
async function refreshCountHint(): Promise<void> {
  if (!els) return;
  const t = await getTemplate();
  const total = totalCount(t);
  els.countInput.placeholder = String(total);
  const base =
    t.usePresets && t.presets.length > 0
      ? `변형 ${t.presets.length} × 반복 ${t.repeats} = ${total}장`
      : `시드만 변경 × ${t.repeats} = ${total}장`;
  els.countInput.title = `생성할 장수 · 템플릿 총량 ${base}`;

  const n = Math.max(1, Number(els.countInput.value) || total);
  const perItem = parseAnlasCostFromGenerateButton();
  // 단가를 못 읽으면 장수만 덩그러니 남아 입력란의 숫자와 겹쳐 보인다 — 위 주석대로
  // 아예 비워서 :empty CSS 규칙에 맡긴다.
  if (perItem === null) {
    els.countHint.textContent = '';
    return;
  }
  const cost = n * perItem;
  const bits = [`${n}장`, `${cost.toLocaleString()} ₳`];
  const anlas = readAnlas();
  if (anlas !== null && anlas < cost) bits.push('⚠ Anlas 부족');
  els.countHint.textContent = bits.join(' · ');
}

// ---------------------------------------------------------------------------
// U02: 진단 정보 복사
// ---------------------------------------------------------------------------

async function buildDiagnosticsText(): Promise<string> {
  const settings = await getSettings();
  const manifest = chrome.runtime.getManifest();
  const support = {
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    createImageBitmap: typeof createImageBitmap !== 'undefined',
  };
  const lines: string[] = [
    `NAISU 진단 정보 — ${new Date().toISOString()}`,
    // 이 텍스트는 문제 신고용으로 공개된 곳(이슈 트래커·채팅)에 붙여넣어지기 쉽다.
    // 아래 로그에는 프롬프트 일부와 폴더/파일명이 들어갈 수 있으므로 먼저 알린다.
    '※ 아래 [최근 로그]와 [설정 스냅샷]에는 프롬프트 일부·폴더명이 포함될 수 있습니다.',
    '   공개된 곳에 붙여넣기 전에 한 번 확인해 주세요.',
    `확장 버전: ${manifest.version}`,
    `UA: ${navigator.userAgent}`,
    `OffscreenCanvas 지원: ${support.offscreenCanvas} · createImageBitmap 지원: ${support.createImageBitmap}`,
    '',
    '[설정 스냅샷]',
    `  다운로드 모드: ${settings.downloadMode}`,
    `  다운로드 폴더: ${settings.downloadFolder}`,
    `  파일명 템플릿: ${settings.filenameTemplate}`,
    `  색상 프로파일 보존: ${settings.keepColorProfile}`,
    `  Anlas 하한: ${settings.anlasFloor} (도달 시: ${settings.onAnlasFloor === 'stop' ? '중단' : '일시정지'})`,
    `  쿨다운: ${settings.cooldownMs}ms · 재시도: ${settings.maxRetries}회 · 타임아웃: ${settings.timeoutMs}ms`,
  ];
  if (lastStripDetail) {
    lines.push('', '[마지막 stripStatus.detail]', lastStripDetail);
  }
  lines.push('', `[최근 로그 ${Math.min(DIAG_LOG_LINES, logHistory.length)}줄]`, ...logHistory.slice(-DIAG_LOG_LINES));
  return lines.join('\n');
}

async function copyDiagnostics(): Promise<void> {
  try {
    const text = await buildDiagnosticsText();
    await navigator.clipboard.writeText(text);
    toastApi?.log('진단 정보를 클립보드에 복사했습니다', 'good');
  } catch (e) {
    toastApi?.log(`진단 정보 복사 실패 — ${e instanceof Error ? e.message : String(e)}`, 'bad');
  }
}

// ---------------------------------------------------------------------------
// D01: 자동 다운로드 약관 동의 모달
// ---------------------------------------------------------------------------

/**
 * 자동 배치를 시작해도 되는지 확인한다. 이미 동의(버전 일치)했으면 모달 없이 즉시 true.
 * 미동의면 모달을 띄우고, 동의해야 true — 취소/Esc/배경 클릭이면 false(배치 미시작).
 * 계약: runner.ts::runBatch() 첫 줄에서 이 함수 하나만 호출한다 (lib/messages.ts 참고).
 */
export async function ensureDisclaimerAccepted(): Promise<boolean> {
  if (await isDisclaimerAccepted()) return true;
  if (!panel) mountPanel();
  return showDisclaimerModal();
}

function wireDisclaimerModal(root: HTMLElement): void {
  // 모달 자체는 showDisclaimerModal() 호출 시점에 쿼리하므로 여기서는 아무것도 하지 않는다.
  // (마운트 시점에 필요한 배선이 없음 — 자리만 남겨 두어 D01 관련 코드가 한 곳에 모이게 함)
  void root;
}

function showDisclaimerModal(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!els) {
      resolve(false);
      return;
    }
    const overlay = els.root.querySelector('.naisu-disclaimer-overlay') as HTMLElement;
    const dialog = overlay.querySelector('.naisu-disclaimer') as HTMLElement;
    const body = overlay.querySelector('.naisu-disclaimer-body') as HTMLElement;
    const cb = overlay.querySelector('.disclaimer-cb') as HTMLInputElement;
    const acceptBtn = overlay.querySelector('.disclaimer-accept') as HTMLButtonElement;
    const cancelBtn = overlay.querySelector('.disclaimer-cancel') as HTMLButtonElement;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    cb.checked = false;
    acceptBtn.disabled = true;
    overlay.hidden = false;

    const focusables = (): HTMLElement[] =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

    const close = (result: boolean): void => {
      overlay.hidden = true;
      document.removeEventListener('keydown', onKeydown, true);
      cb.removeEventListener('change', onCheck);
      acceptBtn.removeEventListener('click', onAccept);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onBackdrop);
      previouslyFocused?.focus?.();
      resolve(result);
    };
    const onCheck = (): void => {
      acceptBtn.disabled = !cb.checked;
    };
    const onAccept = (): void => {
      if (!cb.checked) return;
      void acceptDisclaimer().then(() => close(true));
    };
    const onCancel = (): void => close(false);
    const onBackdrop = (e: MouseEvent): void => {
      if (e.target === overlay) close(false);
    };
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    cb.addEventListener('change', onCheck);
    acceptBtn.addEventListener('click', onAccept);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKeydown, true);

    body.focus(); // 열릴 때 첫 포커스는 본문 상단
  });
}

async function refreshCountDefault(): Promise<void> {
  // 하위 호환 별칭 — B06 리팩터 이후에는 loadCountFromSettings()/refreshCountHint()를 쓴다.
  await loadCountFromSettings();
  await refreshCountHint();
}
void refreshCountDefault; // 미사용 경고 방지 (외부에서 참조하지 않지만 의도적으로 남겨 둔 별칭)

/** 헤더 잡고 드래그 — 위치는 chrome.storage에 화면 비율로 저장, 놓으면 가장 가까운 모서리로 스냅 */
function enableDrag(root: HTMLElement, handle: HTMLElement, forceTopLeft = false): void {
  const POS_KEY = STORAGE_KEYS.panelPos;
  if (forceTopLeft) {
    applyPanelPos(root, 16, 16);
    savePanelPos(16, 16);
  } else {
    // 저장된 위치 복원 (비율 저장) — 구버전 절대좌표 값도 한 번은 읽어 마이그레이션한다
    void chrome.storage.local.get(POS_KEY).then((g) => {
      const pos = g[POS_KEY] as { leftPct: number; topPct: number } | { left: number; top: number } | undefined;
      if (!pos) return;
      if ('leftPct' in pos && 'topPct' in pos) {
        currentPosRatio = pos;
        applyPanelPos(root, pos.leftPct * window.innerWidth, pos.topPct * window.innerHeight);
      } else if ('left' in pos && 'top' in pos) {
        applyPanelPos(root, pos.left, pos.top);
        savePanelPos(pos.left, pos.top);
      }
    });
  }

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragging = true;
    const rect = root.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const left = Math.max(0, Math.min(window.innerWidth - root.offsetWidth, e.clientX - offsetX));
    const top = Math.max(0, Math.min(window.innerHeight - root.offsetHeight, e.clientY - offsetY));
    applyPanelPos(root, left, top);
  });
  handle.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    // U09: 놓으면 화면상 가장 가까운 모서리로 스냅
    const rect = root.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const corner = nearestCorner(centerX, centerY);
    const pos = cornerPosition(corner, rect.width, rect.height);
    applyPanelPos(root, pos.left, pos.top);
    savePanelPos(pos.left, pos.top);
  });

  window.addEventListener('resize', () => {
    if (root.style.left === '') return; // 드래그 전 기본 위치(right/bottom)는 건드리지 않음
    if (currentPosRatio) {
      const left = Math.max(
        0,
        Math.min(currentPosRatio.leftPct * window.innerWidth, window.innerWidth - root.offsetWidth),
      );
      const top = Math.max(
        0,
        Math.min(currentPosRatio.topPct * window.innerHeight, window.innerHeight - root.offsetHeight),
      );
      applyPanelPos(root, left, top);
      return;
    }
    const rect = root.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - root.offsetHeight);
    applyPanelPos(root, Math.max(0, Math.min(rect.left, maxLeft)), Math.max(0, Math.min(rect.top, maxTop)));
  });
}
