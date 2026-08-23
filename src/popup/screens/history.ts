/**
 * 제작 이력 화면 — 저장된 메타데이터를 최근순으로 보여준다.
 *
 * U10: 검색/필터, 복사, NAI 채우기, JSON 내보내기.
 * U07 연계: "실행 기록" 탭에서 최근 배치 리포트(성공/실패, 실패 사유)를 보여준다.
 */

import { clearHistory, deleteHistoryEntry, getHistory, type HistoryEntry } from '../../lib/history';
import { getReports, type BatchReport, type BatchFailure } from '../../lib/storage';
import { sendToTab } from '../../lib/messages';
import { $, must } from '../ui/dom';
import { makeConfirmBtn } from '../ui/confirm';
import { bindSeg } from '../ui/seg';
import type { Screen } from './types';

/** 팝업에서 한 번에 그리는 최대 항목 수 (저장은 더 많이 되어 있을 수 있음) */
const RENDER_LIMIT = 100;
const PROMPT_MAX = 160;
const CHAR_PROMPT_MAX = 120;
const SEARCH_DEBOUNCE_MS = 250;
const NAI_IMAGE_URL = 'https://novelai.net/image';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatSampler(s: string): string {
  return s.replace(/^k_/, '').replace(/_ancestral$/, ' A').replace(/_/g, ' ');
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
}

const STOP_LABEL: Record<BatchReport['stoppedBy'], string> = {
  complete: '완료',
  user: '사용자 중단',
  anlas: 'Anlas 부족',
  error: '오류',
};

// ---------------------------------------------------------------------------
// 이력 탭 — 상태
// ---------------------------------------------------------------------------

let fullList: HistoryEntry[] = [];
let naiTabId: number | null = null;
let searchTimer: number | undefined;

/** 활성 탭이 NAI 이미지 페이지면 그 탭 id를, 아니면 null을 돌려준다. */
async function findActiveNaiTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id != null && tab.url?.startsWith(NAI_IMAGE_URL) ? tab.id : null;
}

/** 버튼 텍스트를 잠깐 바꿨다가 되돌리는 피드백 헬퍼 (복사됨/실패 등). */
function flashButton(btn: HTMLButtonElement, text: string, ms = 1400): void {
  const original = btn.dataset.label ?? btn.textContent ?? '';
  btn.dataset.label = original;
  btn.textContent = text;
  window.setTimeout(() => {
    btn.textContent = btn.dataset.label ?? original;
  }, ms);
}

function makePromptBlock(label: string | null, text: string, maxLen: number, isChar: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'hist-block';
  if (label) {
    const lbl = document.createElement('span');
    lbl.className = isChar ? 'hist-label hist-label-char' : 'hist-label';
    lbl.textContent = label;
    wrap.appendChild(lbl);
  }
  const p = document.createElement('div');
  p.className = 'hist-prompt';
  p.textContent = text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  wrap.appendChild(p);
  return wrap;
}

/** 복사 + NAI 채우기 액션 행. */
function makeActionRow(entry: HistoryEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row gap';
  row.style.marginTop = '6px';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn';
  copyBtn.style.cssText = 'font-size:11px;padding:5px 8px;min-height:30px';
  copyBtn.textContent = '복사';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(entry.prompt);
      flashButton(copyBtn, '복사됨');
    } catch {
      flashButton(copyBtn, '복사 실패');
    }
  });
  row.appendChild(copyBtn);

  const fillBtn = document.createElement('button');
  fillBtn.className = 'btn';
  fillBtn.style.cssText = 'font-size:11px;padding:5px 8px;min-height:30px';
  fillBtn.textContent = 'NAI에 채우기';
  const statusEl = document.createElement('span');
  statusEl.className = 'hint mini';
  statusEl.style.cssText = 'display:block;margin-top:3px';

  const applyFillState = () => {
    if (naiTabId == null) {
      fillBtn.disabled = true;
      fillBtn.title = 'NovelAI 이미지 탭(novelai.net/image)이 활성화되어 있어야 합니다';
    } else {
      fillBtn.disabled = false;
      fillBtn.title = '';
    }
  };
  applyFillState();

  fillBtn.addEventListener('click', async () => {
    if (naiTabId == null) return;
    fillBtn.disabled = true;
    statusEl.textContent = '채우는 중…';
    try {
      const resp = await sendToTab(naiTabId, 'naisu.prompt.fill', { prompt: entry.prompt, uc: entry.uc });
      statusEl.textContent = resp.ok ? '채웠습니다' : `실패 — ${resp.reason ?? '알 수 없는 사유'}`;
    } catch {
      statusEl.textContent = '실패 — NAI 탭에 연결할 수 없습니다 (새로고침 후 다시 시도해 주세요)';
    } finally {
      fillBtn.disabled = naiTabId == null;
      window.setTimeout(() => {
        statusEl.textContent = '';
      }, 3000);
    }
  });
  row.appendChild(fillBtn);

  const wrap = document.createElement('div');
  wrap.appendChild(row);
  wrap.appendChild(statusEl);
  return wrap;
}

function makeHistoryItem(entry: HistoryEntry): HTMLElement {
  const el = document.createElement('div');
  el.className = 'hist-item';

  const stats = [
    entry.seed != null ? `seed ${entry.seed}` : '',
    entry.width && entry.height ? `${entry.width}×${entry.height}` : '',
    entry.steps ? `${entry.steps}st` : '',
    entry.sampler ? formatSampler(entry.sampler) : '',
    entry.model ? entry.model : '',
  ].filter(Boolean);

  const top = document.createElement('div');
  top.className = 'hist-top';

  const meta = document.createElement('div');
  meta.className = 'hist-meta';
  const tsEl = document.createElement('span');
  tsEl.className = 'hist-ts';
  tsEl.textContent = formatDateTime(entry.savedAt);
  meta.appendChild(tsEl);
  if (stats.length > 0) {
    const statsEl = document.createElement('span');
    statsEl.className = 'hist-stats-inline';
    statsEl.textContent = stats.join(' · ');
    meta.appendChild(statsEl);
  }
  top.appendChild(meta);

  const del = document.createElement('button');
  del.className = 'hist-del';
  del.title = '삭제';
  del.textContent = '✕';
  del.addEventListener('click', async () => {
    await deleteHistoryEntry(entry.id);
    fullList = fullList.filter((e) => e.id !== entry.id);
    el.remove();
    const list = $('#history-list');
    if (list && !list.firstChild) {
      const empty = $('#history-empty');
      if (empty) empty.hidden = false;
    }
  });
  top.appendChild(del);
  el.appendChild(top);

  const hasChars = !!entry.characters && entry.characters.length > 0;
  el.appendChild(makePromptBlock(hasChars ? '배경' : null, entry.prompt, PROMPT_MAX, false));
  entry.characters?.forEach((c, i) => {
    el.appendChild(makePromptBlock(`캐릭터 ${i + 1}`, c, CHAR_PROMPT_MAX, true));
  });
  el.appendChild(makeActionRow(entry));

  return el;
}

function matchesFilter(entry: HistoryEntry, query: string, model: string): boolean {
  if (model && entry.model !== model) return false;
  if (!query) return true;
  const hay = [entry.prompt, ...(entry.characters ?? [])].join('\n').toLowerCase();
  return hay.includes(query);
}

function buildModelOptions(list: HistoryEntry[]): void {
  const select = $<HTMLSelectElement>('#hist-model-filter');
  if (!select) return;
  const current = select.value;
  const models = Array.from(new Set(list.map((e) => e.model).filter((m): m is string => !!m))).sort();

  select.textContent = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = '모든 모델';
  select.appendChild(allOpt);
  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  });
  select.value = models.includes(current) ? current : '';
}

function renderFilteredHistory(): void {
  const container = must('#history-list');
  const empty = must('#history-empty');
  const noResult = must('#history-noresult');
  const clearBtn = $<HTMLButtonElement>('#history-clear-btn');
  const search = $<HTMLInputElement>('#hist-search');
  const modelFilter = $<HTMLSelectElement>('#hist-model-filter');

  const query = (search?.value ?? '').trim().toLowerCase();
  const model = modelFilter?.value ?? '';
  const filtered = fullList.filter((e) => matchesFilter(e, query, model));

  container.innerHTML = '';
  empty.hidden = fullList.length > 0;
  if (clearBtn) clearBtn.hidden = fullList.length === 0;
  noResult.hidden = fullList.length === 0 || filtered.length > 0;

  filtered.slice(0, RENDER_LIMIT).forEach((entry) => container.appendChild(makeHistoryItem(entry)));
}

function exportHistoryJson(): void {
  const json = JSON.stringify(fullList, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const a = document.createElement('a');
  a.href = url;
  a.download = `naisu-history_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------------------
// 실행 기록 탭 (U07 연계)
// ---------------------------------------------------------------------------

function makeFailureLine(f: BatchFailure): HTMLElement {
  const line = document.createElement('div');
  line.className = 'hist-prompt';
  const shortPrompt = f.prompt.length > 80 ? `${f.prompt.slice(0, 80)}…` : f.prompt;
  line.textContent = `#${f.idx + 1} ${shortPrompt} — ${f.reason}`;
  if (f.detail) line.title = f.detail;
  return line;
}

function makeReportItem(r: BatchReport): HTMLElement {
  const el = document.createElement('div');
  el.className = 'hist-item';

  const top = document.createElement('div');
  top.className = 'hist-top';
  const meta = document.createElement('div');
  meta.className = 'hist-meta';

  const tsEl = document.createElement('span');
  tsEl.className = 'hist-ts';
  tsEl.textContent = `${formatDateTime(r.startedAt)} · ${formatDuration(r.finishedAt - r.startedAt)}`;
  meta.appendChild(tsEl);

  const statsEl = document.createElement('span');
  statsEl.className = 'hist-stats-inline';
  statsEl.textContent = `${r.done}/${r.total}장 · 저장 ${r.savedFiles}개 · Anlas ${r.anlasUsed} · ${STOP_LABEL[r.stoppedBy]}`;
  meta.appendChild(statsEl);
  top.appendChild(meta);
  el.appendChild(top);

  const nameBlock = document.createElement('div');
  nameBlock.className = 'hist-block';
  const nameP = document.createElement('div');
  nameP.className = 'hist-prompt';
  nameP.style.fontWeight = '700';
  nameP.textContent = r.templateName || '(이름 없는 템플릿)';
  nameBlock.appendChild(nameP);
  el.appendChild(nameBlock);

  if (r.failures.length > 0) {
    const failWrap = document.createElement('div');
    failWrap.className = 'hist-block';
    const lbl = document.createElement('span');
    lbl.className = 'hist-label';
    lbl.textContent = `실패 ${r.failures.length}건`;
    failWrap.appendChild(lbl);
    r.failures.forEach((f) => failWrap.appendChild(makeFailureLine(f)));
    el.appendChild(failWrap);
  }

  return el;
}

async function renderReports(): Promise<void> {
  const list = await getReports();
  const container = must('#reports-list');
  const empty = must('#reports-empty');
  container.innerHTML = '';
  empty.hidden = list.length > 0;
  list.forEach((r) => container.appendChild(makeReportItem(r)));
}

// ---------------------------------------------------------------------------
// 화면 정의
// ---------------------------------------------------------------------------

export const historyScreen: Screen = {
  name: 'history',

  render: () => `
    <section class="screen" data-screen="history" hidden>
      <header class="hd sub">
        <button class="back" data-nav="home">←</button>
        <h2>제작 이력</h2>
      </header>

      <div class="seg" id="hist-tabs" role="radiogroup" style="--seg-n:2">
        <span class="seg-indicator"></span>
        <button data-v="history">이력</button>
        <button data-v="reports">실행 기록</button>
      </div>

      <div id="hist-tab-history">
        <div class="card" style="display:flex;flex-direction:column;gap:8px">
          <input type="text" id="hist-search" placeholder="프롬프트 검색…">
          <div class="row gap">
            <select id="hist-model-filter"><option value="">모든 모델</option></select>
            <button class="btn" id="history-export-btn" style="flex:none;font-size:12px;padding:8px 12px">내보내기</button>
          </div>
        </div>

        <div id="history-list"></div>
        <div id="history-empty" class="empty-state" hidden>아직 저장된 이력이 없습니다<br><span style="font-size:11px">NAI에서 이미지를 생성하면 자동으로 저장됩니다</span></div>
        <div id="history-noresult" class="empty-state" hidden>검색/필터에 맞는 이력이 없습니다</div>

        <button class="btn hist-clear-btn" id="history-clear-btn" style="width:100%;font-size:11px;padding:8px 10px" hidden>전체 삭제</button>
      </div>

      <div id="hist-tab-reports" hidden>
        <div id="reports-list"></div>
        <div id="reports-empty" class="empty-state" hidden>아직 실행 기록이 없습니다<br><span style="font-size:11px">배치를 끝까지 실행하면 성공/실패 요약이 여기 쌓입니다</span></div>
      </div>
    </section>
  `,

  mount() {
    bindSeg(must('#hist-tabs'), 'history', (v) => {
      const historyTab = must('#hist-tab-history');
      const reportsTab = must('#hist-tab-reports');
      historyTab.hidden = v !== 'history';
      reportsTab.hidden = v !== 'reports';
      if (v === 'reports') void renderReports();
    });

    const clearBtn = $<HTMLButtonElement>('#history-clear-btn');
    if (clearBtn) {
      makeConfirmBtn(
        clearBtn,
        async () => {
          await clearHistory();
          await historyScreen.enter?.();
        },
        '정말 삭제할까요? 한 번 더',
      );
    }

    $<HTMLInputElement>('#hist-search')?.addEventListener('input', () => {
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(renderFilteredHistory, SEARCH_DEBOUNCE_MS);
    });
    $<HTMLSelectElement>('#hist-model-filter')?.addEventListener('change', renderFilteredHistory);
    $<HTMLButtonElement>('#history-export-btn')?.addEventListener('click', exportHistoryJson);
  },

  async enter() {
    const [list, tabId] = await Promise.all([getHistory(), findActiveNaiTabId()]);
    fullList = list;
    naiTabId = tabId;
    buildModelOptions(fullList);
    renderFilteredHistory();
  },
};
