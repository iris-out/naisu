/**
 * NAISU 플로팅 패널 — NAI 페이지 우하단에 항상 표시.
 * 컴팩트 버전: 헤더(Anlas + 진행) + 1줄 컨트롤 + 로그.
 * 이미지 메타/다운로드 같은 액션은 팝업에서 처리.
 */

import { readAnlas } from './selectors';
import { getTemplate } from '../lib/storage';
import { totalCount } from '../lib/prompt-variator';

const ROOT_ID = 'naisu-root';

// 화살표 하나만으로는 "다운로드"인지 애매해서, 화살표+트레이로 된 표준 다운로드 아이콘을 직접 그림
const DOWNLOAD_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/></svg>';

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
  /** 사용자가 수동 저장 버튼 클릭 */
  onManualDownload(handler: () => Promise<void>): void;
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
  progMini: HTMLElement;
  miniBar: HTMLElement;
  // 헤더 접힘 버튼
  btnHeaderAuto: HTMLButtonElement;
  btnHeaderDl: HTMLButtonElement;
  // 배치 (실행/일시정지/재개 통합 버튼 + 중지)
  btnStartPause: HTMLButtonElement;
  btnStop: HTMLButtonElement;
  countInput: HTMLInputElement;
  // 수동
  btnManualDl: HTMLButtonElement;
  log: HTMLElement;
}

let els: PanelEls | null = null;

let pauseHandler: (() => void) | null = null;
let stopHandler: (() => void) | null = null;
let startHandler: ((count: number) => void) | null = null;
let manualDlHandler: (() => Promise<void>) | null = null;
let wasRunning = false;

export function unmountPanel(): void {
  panel?.remove();
  panel = null;
  els = null;
  toastApi = null;
  pauseHandler = null;
  stopHandler = null;
  startHandler = null;
  manualDlHandler = null;
  wasRunning = false;
}

export function mountPanel(forceTopLeft = false): void {
  if (panel) return;

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="naisu-alerts"></div>
    <div class="naisu-panel">
      <div class="np-h">
        <div class="brand">NAISU</div>
        <div class="np-h-btns">
          <button class="h-btn-auto" title="자동 다운로드 시작">▶ 자동</button>
          <button class="h-btn-dl" title="현재 이미지 저장">${DOWNLOAD_ICON} 저장</button>
        </div>
        <div class="head-info">
          <span class="anlas-mini">—</span>
          <span class="prog-mini">대기 중</span>
        </div>
        <button class="toggle" title="접기">▾</button>
      </div>
      <div class="np-mini-bar"><span></span></div>
      <div class="np-b">
        <div class="np-row count-row">
          <input class="count" type="number" min="1" value="1" title="생성할 장수">
          <button class="pri" data-batch="startpause" data-action="start">▶ 자동으로</button>
          <button class="icon" data-manual="dl" title="현재 이미지 저장">${DOWNLOAD_ICON}</button>
          <button class="icon r" data-batch="stop" title="중단" disabled>✕</button>
        </div>
        <div class="np-log log"></div>
      </div>
    </div>
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
    progMini: $('.prog-mini'),
    miniBar: $('.np-mini-bar > span'),
    btnHeaderAuto: $('.h-btn-auto') as HTMLButtonElement,
    btnHeaderDl: $('.h-btn-dl') as HTMLButtonElement,
    btnStartPause: $('button[data-batch="startpause"]') as HTMLButtonElement,
    btnStop: $('button[data-batch="stop"]') as HTMLButtonElement,
    countInput: $('.count') as HTMLInputElement,
    btnManualDl: $('button[data-manual="dl"]') as HTMLButtonElement,
    log: $('.log'),
  };

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

  // 템플릿이 바뀔 때마다 기본 장수 갱신 (옵션 페이지에서 수정 시)
  void refreshCountDefault();
  chrome.storage.onChanged.addListener((changes) => {
    if (changes['naisu.template']) void refreshCountDefault();
  });

  // 접기 토글
  els.toggle.addEventListener('click', () => {
    const collapsed = els!.card.classList.toggle('collapsed');
    els!.toggle.textContent = collapsed ? '▴' : '▾';
  });

  // 헤더 드래그
  enableDrag(root, $('.np-h'), forceTopLeft);

  // 이미지 존재 여부 + Anlas 폴링
  startWatchers();

  // 토스트 API 노출 (runner가 사용)
  toastApi = {
    show: () => {
      // 패널은 항상 표시 상태 — 강제 펼침 없음 (사용자가 접은 상태 유지)
    },
    hide: () => {
      els!.card.classList.add('collapsed');
      els!.toggle.textContent = '▴';
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
      // 패널 로그와 별개로 항상 페이지 콘솔(F12)에도 남긴다 — SW 콘솔(chrome://extensions
      // → service worker)은 따로 열어야 보이는 별개 컨텍스트라, 일반 사용자가 캡처해서
      // 보내주기 쉬운 쪽은 이 페이지 콘솔이다.
      (kind === 'bad' ? console.error : kind === 'good' ? console.log : console.info)(`[naisu] ${line}`);
      const div = document.createElement('div');
      const t = new Date();
      const ts = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
      const tag =
        kind === 'good'
          ? `<s>✓</s> `
          : kind === 'bad'
            ? `<em>✕</em> `
            : '';
      div.innerHTML = `<span style="color:#aaa">[${ts}]</span> ${tag}${escapeHtml(line)}`;
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
          els.root.style.top = `${newTop}px`;
          els.root.style.right = 'auto';
          els.root.style.bottom = 'auto';
          void chrome.storage.local.set({ 'naisu.panelPos': { left: rect.left, top: newTop } });
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
      wasRunning = running;
      // 통합 실행/일시정지/재개 버튼
      const spAction = running ? 'pause' : paused ? 'resume' : 'start';
      els!.btnStartPause.dataset.action = spAction;
      els!.btnStartPause.textContent =
        spAction === 'pause' ? '❚❚ 일시정지' : spAction === 'resume' ? '▶ 재개' : '▶ 자동으로';
      els!.btnStartPause.disabled = false;
      // 헤더 버튼 동기화 (접힘 상태 버튼)
      const hAction = running ? 'pause' : paused ? 'resume' : 'start';
      els!.btnHeaderAuto.dataset.action = hAction;
      els!.btnHeaderAuto.textContent =
        hAction === 'pause' ? '❚❚' : hAction === 'resume' ? '▶ 재개' : '▶ 자동';
      els!.btnHeaderAuto.title =
        hAction === 'pause' ? '일시정지' : hAction === 'resume' ? '재개' : '자동 제작 시작';
    },
    onPause: (h) => (pauseHandler = h),
    onStop: (h) => (stopHandler = h),
    onStart: (h) => (startHandler = h),
    onManualDownload: (h) => (manualDlHandler = h),
  };
}

export function getToast(): ToastApi {
  if (!toastApi) mountPanel();
  return toastApi!;
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
  box.innerHTML = `<span class="msg"></span><button class="close" title="닫기" aria-label="닫기">✕</button>`;
  box.querySelector('.msg')!.textContent = message; // XSS 방지 — 항상 textContent로 주입
  const close = () => box.remove();
  box.querySelector('.close')!.addEventListener('click', close);
  els.alerts.appendChild(box);
  while (els.alerts.childElementCount > ALERT_MAX_STACK) els.alerts.firstElementChild?.remove();
  setTimeout(close, ALERT_AUTOHIDE_MS[kind]);
}

function startWatchers(): void {
  // 안전한 가벼운 폴링 (readAnlas는 캐시됨)
  const update = () => {
    if (!els) return;
    const a = readAnlas();
    const txt = a !== null ? a.toLocaleString() : '—';
    els.anlasMini.textContent = `Anlas ${txt}`;
  };
  update();
  setInterval(update, 2000);
}

async function refreshCountDefault(): Promise<void> {
  if (!els) return;
  const t = await getTemplate();
  const total = totalCount(t);
  if (document.activeElement === els.countInput) return; // 사용자 입력 중이면 무시
  els.countInput.value = String(Math.max(1, total));
  els.countInput.title =
    t.usePresets && t.presets.length > 0
      ? `생성할 장수 · 변형 ${t.presets.length}개`
      : '생성할 장수 · 시드만 변경';
}

/** 헤더 잡고 드래그 — 위치는 chrome.storage에 저장 */
function enableDrag(root: HTMLElement, handle: HTMLElement, forceTopLeft = false): void {
  const POS_KEY = 'naisu.panelPos';
  if (forceTopLeft) {
    applyPos(16, 16);
    void chrome.storage.local.set({ [POS_KEY]: { left: 16, top: 16 } });
  } else {
    // 저장된 위치 복원
    void chrome.storage.local.get(POS_KEY).then((g) => {
      const pos = g[POS_KEY] as { left: number; top: number } | undefined;
      if (pos) applyPos(pos.left, pos.top);
    });
  }

  function applyPos(left: number, top: number): void {
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
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
    applyPos(left, top);
  });
  handle.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    const rect = root.getBoundingClientRect();
    void chrome.storage.local.set({ [POS_KEY]: { left: rect.left, top: rect.top } });
  });

  window.addEventListener('resize', () => {
    if (root.style.left === '') return; // 드래그 전 기본 위치(right/bottom)는 건드리지 않음
    const rect = root.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - root.offsetHeight);
    const newLeft = Math.max(0, Math.min(rect.left, maxLeft));
    const newTop = Math.max(0, Math.min(rect.top, maxTop));
    applyPos(newLeft, newTop);
  });
}
