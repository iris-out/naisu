import {
  getSettings,
  setSettings,
  getTemplate,
  setTemplate,
  cryptoId,
  type DownloadMode,
  type BatchTemplate,
  type VariationMode,
  type Settings,
} from '../lib/storage';
import { totalCount } from '../lib/prompt-variator';
import {
  getHistory,
  deleteHistoryEntry,
  clearHistory,
  type HistoryEntry,
} from '../lib/history';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T | null;
const $$ = <T extends HTMLElement = HTMLElement>(s: string) => Array.from(document.querySelectorAll<T>(s));

let template: BatchTemplate;

// ---- 헬퍼 ----
function setHint(s: string) {
  const el = $('#hint');
  if (el) el.textContent = s;
}
function setHeadStat(s: string) {
  const el = $('#head-stat');
  if (el) el.textContent = s;
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

// ---- 라우터 ----
function nav(name: string) {
  $$('.screen').forEach((s) => (s.hidden = s.dataset.screen !== name));
  if (name === 'home') void refreshHomeMenu();
  if (name === 'history') void refreshHistory();
  if (name === 'about') void refreshAbout();
}
function bindRouter() {
  document.body.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[data-nav]') as HTMLElement | null;
    if (t) {
      e.preventDefault();
      nav(t.dataset.nav!);
    }
  });
}

// ---- 스위치 토글 ----
function bindSwitch(el: HTMLElement, value: boolean, onChange: (v: boolean) => void | Promise<void>) {
  const apply = (v: boolean) => el.classList.toggle('on', v);
  apply(value);
  el.addEventListener('click', async () => {
    if (el.classList.contains('locked')) return;
    const next = !el.classList.contains('on');
    apply(next);
    await onChange(next);
  });
}

// ---- 메뉴 라벨 갱신 ----
async function refreshHomeMenu() {
  const s = await getSettings();
  const t = template ?? (await getTemplate());
  const total = totalCount(t);
  const summary =
    t.usePresets && t.presets.length > 0
      ? `변형 ${t.presets.length}개 · ${total}장`
      : `${total}장 (시드만)`;
  $('#m-batch-val')!.textContent = summary;
  $('#m-storage-val')!.textContent = `${labelDl(s.downloadMode)} · ${s.downloadFolder}/`;
  $('#m-safety-val')!.textContent = `Anlas ≥ ${s.anlasFloor}`;
  $('#m-discord-val')!.textContent = s.discord.url ? '연결됨' : '없음';

  const hist = await getHistory();
  const histVal = $('#m-history-val');
  if (histVal) histVal.textContent = hist.length > 0 ? `${hist.length}개` : '없음';

  const manifest = chrome.runtime.getManifest();
  const aboutVal = $('#m-about-val');
  if (aboutVal) aboutVal.textContent = `v${manifest.version}`;
}
function labelDl(m: DownloadMode) {
  return m === 'clean' ? '클린' : m === 'raw' ? '원본' : '둘 다';
}

// ---- 활성 탭 ----
async function checkActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith('https://novelai.net/image')) {
      setHeadStat('연결됨');
      let anlas: number | null = null;

      // 1차: content script 메시지 (이미 로드된 경우 빠름)
      try {
        const resp = await chrome.tabs.sendMessage(tab.id!, { type: 'naisu.query.anlas' });
        if (resp?.anlas != null) anlas = resp.anlas as number;
      } catch { /* content script 미로드 — scripting fallback 시도 */ }

      // 2차: scripting.executeScript로 직접 XPath 쿼리 (content script 없어도 동작)
      if (anlas === null && tab.id != null) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (): number | null => {
              const xpaths = [
                "//span[normalize-space(text())='Anlas:']/..",
                "//*[normalize-space(text())='Anlas:']/..",
              ];
              for (const xpath of xpaths) {
                const r = document.evaluate(
                  xpath, document.body, null,
                  XPathResult.FIRST_ORDERED_NODE_TYPE, null,
                );
                const labelParent = r.singleNodeValue as Element | null;
                const sibling =
                  labelParent?.nextElementSibling?.querySelector('span') ??
                  labelParent?.nextElementSibling ?? null;
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
          const val = results?.[0]?.result;
          if (val != null) anlas = val as number;
        } catch { /* scripting 실패 (페이지 로딩 중 등) */ }
      }

      if (anlas !== null) $('#anlas')!.textContent = anlas.toLocaleString();
    } else {
      setHeadStat('NovelAI 탭을 열어 주세요');
    }
  } catch {
    setHeadStat('—');
  }
}

// ---- 변형/시드 제약 동기화 ----
// 유일하게 금지된 상태: usePresets=off + randomSeed=off (동일 프롬프트+시드 → NAI 차단).
// 잠금은 "지금 끄면 두 스위치가 모두 off가 되는" 전환 하나만 막는다.
function syncSeedPresetConstraint(): void {
  const seedSw = $('#random-seed-sw');
  const presetSw = $('#use-presets-sw');
  const seedNote = $('#seed-constraint-note');
  const presetNote = $('#preset-constraint-note');
  if (!seedSw || !presetSw) return;

  // seed를 끄면 두 스위치 모두 off → 잠금 (usePresets가 이미 off이고 seed가 on일 때만)
  const seedLocked = !template.usePresets && template.randomSeed;
  seedSw.classList.toggle('locked', seedLocked);
  if (seedNote) seedNote.hidden = !seedLocked;

  // presets를 끄면 두 스위치 모두 off → 잠금 (randomSeed가 이미 off이고 presets가 on일 때만)
  const presetLocked = !template.randomSeed && template.usePresets;
  presetSw.classList.toggle('locked', presetLocked);
  if (presetNote) presetNote.hidden = !presetLocked;
}

// ---- 배치 ----
function renderPresets() {
  const wrap = $('#presets');
  if (!wrap) return;
  wrap.innerHTML = '';
  template.presets.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pr-row';
    row.innerHTML = `
      <div class="i">${String(i + 1).padStart(2, '0')}</div>
      <input type="text" value="${escapeAttr(p.text)}">
      <button class="x" title="삭제">✕</button>`;
    const input = row.querySelector('input')!;
    input.addEventListener('input', () => { p.text = input.value; void persistTemplate(); });
    row.querySelector('button')?.addEventListener('click', () => {
      template.presets = template.presets.filter((x) => x.id !== p.id);
      void persistTemplate();
      renderPresets();
      renderTotals();
    });
    wrap.appendChild(row);
  });
  const add = document.createElement('div');
  add.className = 'pr-row pr-add';
  add.innerHTML = `
    <div class="i">+</div>
    <input type="text" placeholder="추가할 내용 입력">
    <button class="x">추가</button>`;
  const addInput = add.querySelector('input') as HTMLInputElement;
  const commit = () => {
    const text = addInput.value.trim();
    if (!text) return;
    template.presets.push({ id: cryptoId(), text });
    addInput.value = '';
    void persistTemplate();
    renderPresets();
    renderTotals();
  };
  add.querySelector('button')?.addEventListener('click', commit);
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  wrap.appendChild(add);
}

function renderTotals() {
  const total = totalCount(template);
  const n = template.presets.length;
  $('#preset-ct')!.textContent = `${n}개`;
  $('#totals')!.textContent = template.usePresets && n > 0
    ? `→ ${n} × ${template.repeats} = ${total}장`
    : `→ ${template.repeats}장 (시드만)`;
  // 프리셋 카드 노출 여부 + 차이
  const card = $('#presets-card');
  if (card) card.style.opacity = template.usePresets ? '1' : '.45';
}

let persistTimer: number | undefined;
async function persistTemplate() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = window.setTimeout(async () => {
    await setTemplate(template);
    setHint('저장됨');
    setTimeout(() => setHint('자동으로 저장됩니다'), 1000);
  }, 200);
}

async function bindBatch() {
  template = await getTemplate();

  // 저장된 상태가 유효하지 않은 경우 교정 (usePresets=off + randomSeed=off)
  if (!template.usePresets && !template.randomSeed) {
    template.randomSeed = true;
    await setTemplate(template);
  }

  ($('#fixed-prompt') as HTMLTextAreaElement).value = template.fixedPrompt;
  ($('#fixed-prompt') as HTMLTextAreaElement).addEventListener('input', (e) => {
    template.fixedPrompt = (e.target as HTMLTextAreaElement).value;
    void persistTemplate();
  });

  bindSwitch($('#use-presets-sw')!, template.usePresets, async (v) => {
    template.usePresets = v;
    await persistTemplate();
    renderTotals();
    syncSeedPresetConstraint();
  });

  bindSwitch($('#random-seed-sw')!, template.randomSeed, async (v) => {
    template.randomSeed = v;
    await persistTemplate();
    syncSeedPresetConstraint();
  });

  const repeats = $('#repeats') as HTMLInputElement;
  repeats.value = String(template.repeats);
  repeats.addEventListener('input', () => {
    template.repeats = Math.max(1, Number(repeats.value) || 1);
    void persistTemplate();
    renderTotals();
  });

  $$('#mode-toggle button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === template.mode);
    b.addEventListener('click', () => {
      template.mode = b.dataset.v as VariationMode;
      $$('#mode-toggle button').forEach((x) => x.classList.toggle('on', x === b));
      void persistTemplate();
    });
  });

  renderPresets();
  renderTotals();
  syncSeedPresetConstraint();
}

// ---- 저장 설정 ----
async function bindStorage() {
  const s = await getSettings();
  // 다운로드 모드 — 두 개 위치 (홈+상세) 동기화
  const syncDl = (active: DownloadMode) => {
    $$('#dl-mode-2 button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === active);
    });
  };
  syncDl(s.downloadMode);
  $$('#dl-mode-2 button').forEach((b) => {
    b.addEventListener('click', async () => {
      const v = b.dataset.v as DownloadMode;
      syncDl(v);
      await setSettings({ downloadMode: v });
      setHint('저장됨');
    });
  });

  bindInput('#folder', s.downloadFolder, async (v) => { await setSettings({ downloadFolder: v }); });
  bindInput('#filename-tpl', s.filenameTemplate, async (v) => { await setSettings({ filenameTemplate: v }); });
  $$('#filename-tokens span').forEach((sp) =>
    sp.addEventListener('click', () => {
      const inp = $('#filename-tpl') as HTMLInputElement;
      inp.value += sp.textContent ?? '';
      inp.dispatchEvent(new Event('input'));
    }),
  );

  bindSwitch($('#keep-color-sw')!, s.keepColorProfile, async (v) => {
    await setSettings({ keepColorProfile: v });
  });
}

// ---- 안전장치 ----
async function bindSafety() {
  const s = await getSettings();
  bindInput('#anlas-floor', String(s.anlasFloor), async (v) => { await setSettings({ anlasFloor: Number(v) || 0 }); });
  bindInput('#cooldown', String(s.cooldownMs), async (v) => { await setSettings({ cooldownMs: Number(v) || 0 }); });
  bindInput('#retries', String(s.maxRetries), async (v) => { await setSettings({ maxRetries: Number(v) || 0 }); });
  bindInput('#timeout', String(s.timeoutMs / 1000), async (v) => { await setSettings({ timeoutMs: (Number(v) || 60) * 1000 }); });
}

// ---- Discord ----
async function bindDiscord() {
  const s = await getSettings();
  const url = $('#webhook-url') as HTMLInputElement;
  url.value = s.discord.url;
  url.addEventListener('input', async () => {
    const cur = await getSettings();
    await setSettings({ discord: { ...cur.discord, url: url.value } });
  });

  // 이벤트 스위치들
  const events = s.discord.events;
  $$('.switch[data-ev]').forEach((sw) => {
    const ev = sw.dataset.ev as keyof Settings['discord']['events'];
    bindSwitch(sw, events[ev], async (v) => {
      const cur = await getSettings();
      await setSettings({
        discord: { ...cur.discord, events: { ...cur.discord.events, [ev]: v } },
      });
    });
  });

  const pe = $('#progress-every') as HTMLInputElement;
  pe.value = String(s.discord.progressEvery);
  pe.addEventListener('input', async () => {
    const cur = await getSettings();
    await setSettings({ discord: { ...cur.discord, progressEvery: Math.max(1, Number(pe.value) || 1) } });
  });

  $('#webhook-test')?.addEventListener('click', async () => {
    const cur = await getSettings();
    if (!cur.discord.url) { setHint('Webhook URL을 먼저 입력해 주세요'); return; }
    const r = await chrome.runtime.sendMessage({
      type: 'naisu.webhook',
      payload: { url: cur.discord.url, body: { content: '✅ NAISU 테스트 메시지' } },
    });
    setHint(r?.ok ? '테스트 성공' : '테스트 실패');
  });
}

function bindInput(sel: string, val: string, save: (v: string) => Promise<unknown>) {
  const el = $(sel) as HTMLInputElement;
  el.value = val;
  let t: number | undefined;
  el.addEventListener('input', () => {
    if (t) clearTimeout(t);
    t = window.setTimeout(() => void save(el.value), 200);
  });
}

// ---- 이력 ----
async function refreshHistory(): Promise<void> {
  const list = await getHistory();
  const container = $('#history-list')!;
  const empty = $('#history-empty')!;
  const clearBtn = $('#history-clear-btn') as HTMLButtonElement | null;

  container.innerHTML = '';
  empty.hidden = list.length > 0;
  if (clearBtn) clearBtn.hidden = list.length === 0;

  list.slice(0, 100).forEach((entry) => container.appendChild(makeHistoryItem(entry)));
}

function makeHistoryItem(entry: HistoryEntry): HTMLElement {
  const el = document.createElement('div');
  el.className = 'hist-item';

  const d = new Date(entry.savedAt);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const ts = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

  const statsArr = [
    entry.seed != null ? `seed ${entry.seed}` : '',
    entry.width && entry.height ? `${entry.width}×${entry.height}` : '',
    entry.steps ? `${entry.steps}st` : '',
    entry.sampler ? fmtSampler(entry.sampler) : '',
  ].filter(Boolean);

  // 헤더 줄: 날짜 + 통계 + 삭제 버튼
  const top = document.createElement('div');
  top.className = 'hist-top';

  const meta = document.createElement('div');
  meta.className = 'hist-meta';
  const tsEl = document.createElement('span');
  tsEl.className = 'hist-ts';
  tsEl.textContent = ts;
  meta.appendChild(tsEl);
  if (statsArr.length > 0) {
    const statsEl = document.createElement('span');
    statsEl.className = 'hist-stats-inline';
    statsEl.textContent = statsArr.join(' · ');
    meta.appendChild(statsEl);
  }
  top.appendChild(meta);

  const del = document.createElement('button');
  del.className = 'hist-del';
  del.title = '삭제';
  del.textContent = '✕';
  del.addEventListener('click', async () => {
    await deleteHistoryEntry(entry.id);
    el.remove();
    const cont = $('#history-list')!;
    if (!cont.firstChild) {
      $('#history-empty')!.hidden = false;
      const cb = $('#history-clear-btn') as HTMLButtonElement | null;
      if (cb) cb.hidden = true;
    }
  });
  top.appendChild(del);
  el.appendChild(top);

  // 프롬프트 블록들
  const hasChars = entry.characters && entry.characters.length > 0;
  el.appendChild(makePromptBlock(hasChars ? '배경' : null, entry.prompt, 160, false));
  if (entry.characters) {
    entry.characters.forEach((c, i) => {
      el.appendChild(makePromptBlock(`캐릭터 ${i + 1}`, c, 120, true));
    });
  }

  return el;
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
  p.textContent = text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
  wrap.appendChild(p);
  return wrap;
}

function fmtSampler(s: string): string {
  return s
    .replace(/^k_/, '')
    .replace(/_ancestral$/, ' A')
    .replace(/_/g, ' ');
}

function bindHistoryActions(): void {
  const clearBtn = $('#history-clear-btn') as HTMLButtonElement | null;
  if (!clearBtn) return;
  makeConfirmBtn(clearBtn, async () => {
    await clearHistory();
    void refreshHistory();
  }, '정말 삭제할까요? 한 번 더');
}

// ---- 정보 ----
async function refreshAbout(): Promise<void> {
  const manifest = chrome.runtime.getManifest();
  const verEl = $('#about-version');
  if (verEl) verEl.textContent = `v${manifest.version}`;

  const bytes = await chrome.storage.local.getBytesInUse(null);
  const storageEl = $('#about-storage');
  if (storageEl) {
    storageEl.textContent =
      bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  const hist = await getHistory();
  const histCountEl = $('#about-hist-count');
  if (histCountEl) histCountEl.textContent = `${hist.length} / 500개`;
}

function bindAboutActions(): void {
  const settingsBtn = $('#reset-settings-btn') as HTMLButtonElement | null;
  const dataBtn = $('#reset-data-btn') as HTMLButtonElement | null;

  if (settingsBtn) {
    makeConfirmBtn(settingsBtn, async () => {
      await chrome.storage.local.remove(['naisu.settings', 'naisu.template']);
      window.location.reload();
    }, '정말 초기화할까요? 한 번 더');
  }

  if (dataBtn) {
    makeConfirmBtn(dataBtn, async () => {
      await clearHistory();
      void refreshAbout();
      const histVal = $('#m-history-val');
      if (histVal) histVal.textContent = '없음';
    }, '정말 삭제할까요? 한 번 더');
  }
}

function makeConfirmBtn(btn: HTMLButtonElement, action: () => Promise<void>, confirmText: string): void {
  let timer: number | undefined;
  btn.addEventListener('click', async () => {
    if (btn.dataset.confirm === '1') {
      clearTimeout(timer);
      btn.dataset.confirm = '0';
      btn.classList.remove('danger');
      btn.textContent = btn.dataset.original!;
      await action();
    } else {
      btn.dataset.original = btn.textContent ?? '';
      btn.dataset.confirm = '1';
      btn.classList.add('danger');
      btn.textContent = confirmText;
      timer = window.setTimeout(() => {
        btn.dataset.confirm = '0';
        btn.classList.remove('danger');
        btn.textContent = btn.dataset.original!;
      }, 3000);
    }
  });
}

function bindHomeActions() {
  $('#reset-ui-pos')?.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith('https://novelai.net/image')) {
      setHint('NAI 이미지 탭에서 실행해 주세요');
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'naisu.ui.reset' });
      setHint('UI를 좌상단으로 초기화했습니다');
    } catch {
      setHint('초기화 실패 — 탭을 새로고침 해주세요');
    }
  });
}

void (async function main() {
  bindRouter();
  await bindStorage();
  await bindBatch();
  await bindSafety();
  await bindDiscord();
  bindHistoryActions();
  bindAboutActions();
  bindHomeActions();
  await refreshHomeMenu();
  await checkActiveTab();
})();
