/** 홈 화면 — 설정 검색 + Anlas 잔량 + 실행 제어 + 각 설정 화면으로 가는 메뉴. */

import { getHistory } from '../../lib/history';
import { getSettings, setSettings, type PanelLayout, type Settings } from '../../lib/storage';
import { icon } from '../../lib/icons';
import { trySendToTab, type RunState } from '../../lib/messages';
import { totalCount } from '../../lib/prompt-variator';
import { $, $$ } from '../ui/dom';
import { setHeadStat, flashHint } from '../ui/status';
import { riskBadge } from '../ui/field-ui';
import { searchFields, SCREEN_LABELS, findField, riskOfScreen, type SettingField } from '../settings-registry';
import { nav } from '../router';
import { getEditingTemplate } from './batch';
import { labelDownloadMode } from './storage';
import type { Screen } from './types';

const NAI_IMAGE_URL = 'https://novelai.net/image';

/**
 * 장당 Anlas 소모 어림값. 실제 값은 해상도·스텝·모델에 따라 달라져 정확히 알 수 없다.
 * NAI의 Generate 버튼이 현재 해상도·스텝·동시 생성 장수를 전부 반영한 실제 가격을
 * 표시해 주므로 그 값을 우선 쓴다. 아래 상수는 그 값을 읽지 못했을 때만 쓰는 폴백이다.
 */
const EST_ANLAS_PER_IMAGE = 17;

/** 팝업이 열려 있는 동안 실행 상태를 갱신하는 주기 (B04) */
const LIVE_POLL_MS = 1500;

/** 설정 검색 입력 디바운스 (P2) */
const SEARCH_DEBOUNCE_MS = 150;

const IDLE_STATE: RunState = { running: false, paused: false, done: 0, total: 0, etaSec: 0 };

let liveTimer: number | undefined;
let searchDebounceTimer: number | undefined;

async function activeNaiTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith(NAI_IMAGE_URL) ? tab : null;
}

/** content script가 아직 안 붙었을 때 XPath로 Anlas만 직접 읽는 폴백 (state는 알 수 없음). */
async function readAnlasViaScripting(tabId: number): Promise<number | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (): number | null => {
        const xpaths = [
          "//span[normalize-space(text())='Anlas:']/..",
          "//*[normalize-space(text())='Anlas:']/..",
        ];
        for (const xpath of xpaths) {
          const r = document.evaluate(xpath, document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const labelParent = r.singleNodeValue as Element | null;
          const sibling =
            labelParent?.nextElementSibling?.querySelector('span') ??
            labelParent?.nextElementSibling ??
            null;
          if (sibling) {
            const text = sibling.textContent?.replace(/[^\d]/g, '');
            if (text) {
              const n = Number(text);
              if (Number.isFinite(n)) return n;
            }
          }
        }
        return null;
      },
    });
    return results?.[0]?.result ?? null;
  } catch {
    // 페이지 로딩 중 등 — 조회 실패는 화면에 '—'로 남는다
    return null;
  }
}

/**
 * 1차: 메시지(content script가 이미 로드됐으면 가장 빠르고, 실행 상태까지 함께 옴)
 * 2차: content script가 아직 안 붙은 탭 — scripting으로 Anlas만 읽고 실행 상태는 idle로 간주.
 */
async function readTabStatus(
  tabId: number,
): Promise<{ anlas: number | null; state: RunState; generateCost: number | null }> {
  const resp = await trySendToTab(tabId, 'naisu.query.anlas');
  if (resp) return resp;
  const anlas = await readAnlasViaScripting(tabId);
  // content script가 아직 안 붙었으면 Generate 버튼 가격도 읽을 수 없다 → null로 두고
  // 호출부가 어림값으로 폴백하게 한다("어림" 배지가 그대로 보인다).
  return { anlas, state: IDLE_STATE, generateCost: null };
}

/** "3/40 · 8% · 약 12분 남음" 형태 (B04) */
function formatProgress(state: RunState): string {
  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
  const base = `${state.done}/${state.total} · ${pct}%`;
  if (state.etaSec <= 0) return base;
  const etaMin = Math.max(1, Math.ceil(state.etaSec / 60));
  return `${base} · 약 ${etaMin}분 남음`;
}

/**
 * Anlas 카드 오른쪽 — 지금 잔량으로 몇 장 더 뽑을 수 있는지 (U05).
 *
 * 예전에는 "이번 배치 예상 소모"도 같이 보여줬는데, 그 값이 패널 입력 장수에 따라
 * 바뀌면서 "왜 3장 기준이냐"는 혼란만 만들었다. 알고 싶은 건 결국 남은 장수 하나다.
 */
async function refreshAnlasEstimate(anlas: number | null, generateCost: number | null): Promise<void> {
  const maxEl = $('#anlas-max-count');
  const noteEl = $('#anlas-cost-note');
  if (!maxEl && !noteEl) return;

  const s = await getSettings();
  // NAI가 계산해 준 실제 단가가 있으면 그걸 쓰고, 없을 때만 어림값으로 폴백한다.
  const perImage = generateCost ?? EST_ANLAS_PER_IMAGE;
  const isMeasured = generateCost !== null;

  if (noteEl) {
    noteEl.textContent = isMeasured
      ? `1회 ${perImage} Anlas · 하한 ${s.anlasFloor} 제외`
      : `1회 약 ${perImage} Anlas (어림)`;
  }
  if (maxEl) {
    if (anlas === null) {
      maxEl.textContent = '—';
      return;
    }
    const usable = Math.max(0, anlas - s.anlasFloor);
    const maxCount = Math.floor(usable / perImage);
    maxEl.textContent = `${isMeasured ? '' : '약 '}${maxCount.toLocaleString()}장`;
  }
}

/** 탭 연결·Anlas·실행 상태를 한 번에 새로고침한다. 폴링 타이머가 이 함수를 반복 호출한다. */
async function refreshLive(): Promise<void> {
  const tab = await activeNaiTab();
  const anlasEl = $('#anlas');

  if (!tab?.id) {
    setHeadStat('NovelAI 탭을 열어 주세요');
    if (anlasEl) anlasEl.textContent = '—';
    await refreshAnlasEstimate(null, null);
    return;
  }

  const { anlas, state, generateCost } = await readTabStatus(tab.id);
  setHeadStat(state.running ? formatProgress(state) : '연결됨');
  if (anlasEl && anlas !== null) anlasEl.textContent = anlas.toLocaleString();
  await refreshAnlasEstimate(anlas, generateCost);
}

function stopLivePolling(): void {
  if (liveTimer !== undefined) {
    clearInterval(liveTimer);
    liveTimer = undefined;
  }
}

/** 홈 화면에 진입할 때마다 새로 건다 — 화면을 떠나면(observer) / 팝업이 닫히면(unload) 반드시 멈춘다. */
function startLivePolling(): void {
  stopLivePolling();
  void refreshLive();
  liveTimer = window.setInterval(() => void refreshLive(), LIVE_POLL_MS);
}

// ---------------------------------------------------------------------------
// 설정 검색 (P2) — 23개 항목이 화면 여러 개로 갈려 있어 메뉴를 뒤지지 않아도 되게 한다.
// ---------------------------------------------------------------------------

/**
 * 검색 결과 한 줄을 만든다. innerHTML 문자열 조립 대신 createElement + textContent를 쓰는
 * 이유는 batch.ts에서 겪은 B05(값에 `&`가 섞이면 innerHTML 파싱 중 한 번 더 디코드되어
 * 조용히 값이 바뀌는 문제)와 같은 함정을 피하기 위해서다 — 여기 값(describe()의 결과)에는
 * 사용자가 입력한 폴더명·파일명 템플릿이 그대로 들어갈 수 있다.
 */
function buildResultRow(f: SettingField, s: Settings): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sr';
  btn.setAttribute('role', 'option');

  const l = document.createElement('span');
  l.className = 'sr-l';
  l.textContent = f.label;

  const where = document.createElement('span');
  where.className = 'sr-where';
  where.textContent = SCREEN_LABELS[f.screen];

  const d = document.createElement('span');
  d.className = 'sr-d';
  d.textContent = [f.describe?.(s), f.help].filter(Boolean).join(' — ');

  btn.append(l, where, d);
  btn.addEventListener('click', () => nav(f.screen));
  return btn;
}

/** 검색 결과 영역 ↔ 원래 메뉴 전환 */
function setSearchActive(active: boolean): void {
  const menus = $('#home-menus');
  const results = $('#search-results');
  if (menus) menus.hidden = active;
  if (results) results.hidden = !active;
}

async function renderSearchResults(query: string): Promise<void> {
  const box = $('#search-results');
  if (!box) return;

  if (!query) {
    box.innerHTML = '';
    setSearchActive(false);
    return;
  }

  setSearchActive(true);
  const s = await getSettings();
  const results = searchFields(query, s);
  box.innerHTML = '';

  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = '검색 결과가 없습니다';
    box.appendChild(empty);
    return;
  }

  results.forEach((f) => box.appendChild(buildResultRow(f, s)));
}

function onSearchInput(value: string): void {
  if (searchDebounceTimer !== undefined) window.clearTimeout(searchDebounceTimer);
  searchDebounceTimer = window.setTimeout(() => void renderSearchResults(value.trim()), SEARCH_DEBOUNCE_MS);
}

/** 검색 결과 안에서 ↑↓로 포커스 이동. 첫 진입 방향에 따라 처음/끝에서 시작한다. */
function moveResultFocus(delta: number): void {
  const rows = $$('#search-results .sr');
  if (rows.length === 0) return;
  const active = document.activeElement;
  const current = rows.indexOf(active as HTMLButtonElement);
  const next = current < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, current + delta));
  rows[next]?.focus();
}

function bindSearch(): void {
  const input = $<HTMLInputElement>('#settings-search');
  const box = $('#search-results');
  if (!input) return;

  input.addEventListener('input', () => onSearchInput(input.value));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      if (searchDebounceTimer !== undefined) window.clearTimeout(searchDebounceTimer);
      void renderSearchResults('');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveResultFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveResultFocus(-1);
    }
  });

  box?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      input.focus();
      if (searchDebounceTimer !== undefined) window.clearTimeout(searchDebounceTimer);
      void renderSearchResults('');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveResultFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveResultFocus(-1);
    }
  });
}

export const homeScreen: Screen = {
  name: 'home',

  render: () => `
    <section class="screen" data-screen="home">
      <header class="hd">
        <div class="brand">NAISU<span style="color:var(--r)">.</span></div>
        <div class="hd-stat" id="head-stat">대기 중</div>
      </header>

      <div class="search-box">
          ${icon('search', 16)}
        <input
          type="text"
          id="settings-search"
          placeholder="설정 검색 — 예: 생성 간격, 파일명"
          aria-label="설정 검색"
          autocomplete="off"
        />
      </div>
      <div class="search-results" id="search-results" role="listbox" aria-label="검색 결과" hidden></div>

      <div class="anlas-card">
        <div>
          <div class="lbl">남은 Anlas</div>
          <div class="big" id="anlas">—</div>
        </div>
        <div style="text-align:right">
          <div class="lbl">더 뽑을 수 있는 장수</div>
          <div class="big" id="anlas-max-count">—</div>
          <div class="hint mini" id="anlas-cost-note">—</div>
        </div>
      </div>

      <div class="m-sec">패널 모양</div>
      <div class="sec-body">
      <div class="lay-pick" id="lay-pick" role="radiogroup" aria-label="플로팅 패널 모양" style="gap:6px">
        <button class="lay" data-v="card" role="radio" aria-checked="true" style="padding:6px">
          <span class="lay-mock lay-mock-card" aria-hidden="true" style="width:64px;height:44px">
            <span class="mk-head"></span><span class="mk-bar"></span>
            <span class="mk-row"><i class="w"></i><i class="fill"></i><i></i></span>
            <span class="mk-log"></span>
          </span>
          <span class="lay-ttl">기본 카드</span>
          <span class="lay-sub">가로 카드형</span>
        </button>
        <button class="lay" data-v="rail" role="radio" aria-checked="false" style="padding:6px">
          <span class="lay-mock lay-mock-rail" aria-hidden="true" style="width:20px;height:44px">
            <span class="mk-head"></span>
            <span class="mk-stack"><i class="fill"></i><i></i><i></i></span>
          </span>
          <span class="lay-ttl">아이콘 레일</span>
          <span class="lay-sub">세로 아이콘만</span>
        </button>
      </div>
      </div>

      <div id="home-menus">
        <div class="m-sec">이미지 생성</div>
        <nav class="menu">
          <button class="m-row" data-nav="batch">
            <span class="m-ico">${icon('layers', 17)}</span>
            <span class="m-txt">
              <span class="m-ttl">배치</span>
              <span class="m-sub" id="m-batch-sub">프롬프트 변형 · 반복 횟수</span>
            </span>
            <span class="m-val" id="m-batch-val">—</span>
            <span class="m-ch">${icon('chevron_right', 15)}</span>
          </button>
          <button class="m-row" data-nav="safety">
            <span class="m-ico">${icon('shield', 17)}</span>
            <span class="m-txt">
              <span class="m-ttl">안전 설정</span>
              <span class="m-sub" id="m-safety-sub">Anlas 하한 · 생성 간격 · 재시도</span>
            </span>
            <span class="m-val" id="m-safety-val">—</span>
            <span class="m-ch">${icon('chevron_right', 15)}</span>
          </button>
        </nav>

        <div class="m-sec">저장</div>
        <nav class="menu">
          <button class="m-row" data-nav="storage">
            <span class="m-ico">${icon('folder_down', 17)}</span>
            <span class="m-txt">
              <span class="m-ttl">다운로드</span>
              <span class="m-sub" id="m-storage-sub">메타데이터 제거 방식 · 품질 · 출력 포맷 · 폴더 · 파일 이름</span>
            </span>
            <span class="m-val" id="m-storage-val">—</span>
            <span class="m-ch">${icon('chevron_right', 15)}</span>
          </button>
          <button class="m-row" data-nav="output">
            <span class="m-ico">${icon('sliders', 17)}</span>
            <span class="m-txt">
              <span class="m-ttl">저장 후처리</span>
              <span class="m-sub">워터마크 · 크레딧</span>
            </span>
            <span class="m-val" id="m-output-val">—</span>
            <span class="m-ch">${icon('chevron_right', 15)}</span>
          </button>
        </nav>

        <div class="m-sec">기타 및 정보</div>
        <nav class="menu">
          <button class="m-row" data-nav="discord">
            <span class="m-ico">${icon('message_circle', 17)}</span>
            <span class="m-txt">
              <span class="m-ttl">알림</span>
              <span class="m-sub">브라우저 알림 · Discord 웹훅</span>
            </span>
            <span class="m-val" id="m-discord-val">없음</span>
            <span class="m-ch">${icon('chevron_right', 15)}</span>
          </button>
          <button class="m-row" data-nav="history">
            <span class="m-ico">${icon('history', 17)}</span>
            <span class="m-txt">
              <span class="m-ttl">제작 이력</span>
              <span class="m-sub">지난 프롬프트 · 시드 다시 쓰기</span>
            </span>
            <span class="m-val" id="m-history-val">—</span>
            <span class="m-ch">${icon('chevron_right', 15)}</span>
          </button>
          <button class="m-row" data-nav="about">
            <span class="m-ico">${icon('info', 17)}</span>
            <span class="m-txt">
              <span class="m-ttl">정보</span>
              <span class="m-sub">버전 · 저장 공간 · 초기화</span>
            </span>
            <span class="m-val" id="m-about-val">—</span>
            <span class="m-ch">${icon('chevron_right', 15)}</span>
          </button>
        </nav>
      </div>

      <footer class="ft">
        <span id="hint">자동으로 저장됩니다</span>
      </footer>
    </section>
  `,

  async mount() {
    bindSearch();

    const pick = $('#lay-pick');
    if (pick) {
      const buttons = Array.from(pick.querySelectorAll<HTMLButtonElement>('button[data-v]'));
      const activate = (v: PanelLayout) => {
        buttons.forEach((b) => {
          const on = b.dataset.v === v;
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', String(on));
          b.tabIndex = on ? 0 : -1;
        });
      };
      activate((await getSettings()).panelLayout);
      buttons.forEach((b) =>
        b.addEventListener('click', async () => {
          const v = b.dataset.v as PanelLayout;
          activate(v);
          await setSettings({ panelLayout: v });
          flashHint('패널 모양을 바꿨습니다');
        }),
      );
    }

    // 화면이 숨겨지면(다른 화면으로 이동) 폴링을 멈춘다 — 팝업이 자주 열고 닫히므로 타이머 누수 주의.
    // 라우터(router.ts)는 소유 파일이 아니라 leave 훅을 추가할 수 없어서, hidden 속성 변화를
    // 직접 관찰한다.
    const section = $('[data-screen="home"]');
    if (section) {
      const observer = new MutationObserver(() => {
        if (section.hidden) stopLivePolling();
      });
      observer.observe(section, { attributes: true, attributeFilter: ['hidden'] });
    }
    window.addEventListener('unload', stopLivePolling);
  },

  async enter() {
    const [s, t, hist] = await Promise.all([getSettings(), getEditingTemplate(), getHistory()]);

    const total = totalCount(t);
    const batchSub =
      t.usePresets && t.presets.length > 0 ? `변형 ${t.presets.length}개 조합` : '고정 프롬프트 · 시드만 랜덤';

    const set = (sel: string, text: string) => {
      const el = $(sel);
      if (el) el.textContent = text;
    };
    // 배지 HTML은 riskBadge()가 만든 신뢰된 마크업(라벨은 고정 문구/짧은 커스텀 텍스트)만
    // 흘려보낸다 — 사용자 입력을 그대로 얹지 않으므로 innerHTML이어도 안전하다.
    const setBadge = (sel: string, html: string) => {
      const el = $(sel);
      if (el) el.innerHTML = html;
    };

    set('#m-batch-val', `${total}장`);
    set('#m-batch-sub', batchSub);

    const safetyRisk = riskOfScreen('safety', s);
    setBadge('#m-safety-val', riskBadge(safetyRisk.level));
    set(
      '#m-safety-sub',
      `${findField('cooldownMs')?.describe?.(s) ?? ''} · ${findField('maxRetries')?.describe?.(s) ?? ''}`,
    );

    const storageRisk = riskOfScreen('storage', s);
    setBadge('#m-storage-val', riskBadge(storageRisk.level, labelDownloadMode(s.downloadMode)));
    set('#m-storage-sub', `${s.downloadFolder}/ · ${s.filenameTemplate}`);

    set('#m-output-val', findField('imageOps')?.describe?.(s) ?? '없음');

    set(
      '#m-discord-val',
      `${findField('notifications')?.describe?.(s) ?? ''} · ${findField('discord')?.describe?.(s) ?? ''}`,
    );
    set('#m-history-val', hist.length > 0 ? `${hist.length}개` : '없음');
    set('#m-about-val', `v${chrome.runtime.getManifest().version}`);

    startLivePolling();
  },
};
