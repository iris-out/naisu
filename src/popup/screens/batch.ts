/**
 * 배치 화면 — 고정 프롬프트 + 변형 프리셋 + 반복 횟수.
 * 편집 중인 템플릿의 단일 사본을 여기서 들고 있고, 변경은 디바운스로 저장한다.
 */

import { cryptoId, getTemplate, setTemplate, type BatchTemplate, type VariationMode } from '../../lib/storage';
import { totalCount, preview } from '../../lib/prompt-variator';
import { $, must } from '../ui/dom';
import { flashHint } from '../ui/status';
import { bindSeg } from '../ui/seg';
import { bindSwitch } from '../ui/switch';
import type { Screen } from './types';

const PERSIST_DEBOUNCE_MS = 200;
const REMOVE_ANIM_MS = 150;
/** 전개 미리보기에 보여줄 개수 (U01) */
const PREVIEW_COUNT = 8;
/**
 * 장당 Anlas 소모 어림값. content/runner.ts의 perItemAnlas(같은 어림)와 맞춘 값이며
 * 정확한 실측치가 아니라 미리보기용 어림이다.
 */
const EST_ANLAS_PER_IMAGE = 17;

let template: BatchTemplate | null = null;
let persistTimer: number | undefined;

/**
 * 홈 화면이 요약을 그릴 때 쓴다.
 * 저장이 디바운스되므로, 편집 중인 사본이 있으면 그쪽이 항상 최신이다.
 */
export async function getEditingTemplate(): Promise<BatchTemplate> {
  return template ?? (await getTemplate());
}

function persistTemplate(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = window.setTimeout(async () => {
    if (!template) return;
    await setTemplate(template);
    flashHint('저장됨');
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * 유일하게 금지된 상태: usePresets=off + randomSeed=off (동일 프롬프트+시드 → NAI 차단).
 * 잠금은 "지금 끄면 두 스위치가 모두 off가 되는" 전환 하나만 막는다.
 */
function syncSeedPresetConstraint(): void {
  if (!template) return;
  const seedSw = $('#random-seed-sw');
  const presetSw = $('#use-presets-sw');
  const seedNote = $('#seed-constraint-note');
  const presetNote = $('#preset-constraint-note');
  if (!seedSw || !presetSw) return;

  const seedLocked = !template.usePresets && template.randomSeed;
  seedSw.classList.toggle('locked', seedLocked);
  if (seedNote) seedNote.hidden = !seedLocked;

  const presetLocked = !template.randomSeed && template.usePresets;
  presetSw.classList.toggle('locked', presetLocked);
  if (presetNote) presetNote.hidden = !presetLocked;
}

/**
 * `&`가 섞인 값을 innerHTML 문자열에 끼워 넣으면(구버전 escapeAttr는 따옴표만 이스케이프)
 * 한 번 더 디코드되어 사용자 프리셋이 조용히 바뀐다(B05). createElement + .value 대입은
 * 문자열 파싱을 거치지 않으므로 이스케이프가 아예 필요 없다.
 */
function renderPresets(): void {
  if (!template) return;
  const wrap = $('#presets');
  if (!wrap) return;
  const t = template;
  wrap.innerHTML = '';
  t.presets.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pr-row';

    const idx = document.createElement('div');
    idx.className = 'i';
    idx.textContent = String(i + 1).padStart(2, '0');

    const input = document.createElement('input');
    input.type = 'text';
    input.value = p.text;
    input.addEventListener('input', () => {
      p.text = input.value;
      persistTemplate();
      renderPreview();
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'x';
    removeBtn.title = '삭제';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      row.classList.add('is-removing');
      setTimeout(() => {
        t.presets = t.presets.filter((x) => x.id !== p.id);
        persistTemplate();
        renderPresets();
        renderTotals();
        renderPreview();
      }, REMOVE_ANIM_MS);
    });

    row.append(idx, input, removeBtn);
    wrap.appendChild(row);
  });

  const add = document.createElement('div');
  add.className = 'pr-row pr-add';

  const addIdx = document.createElement('div');
  addIdx.className = 'i';
  addIdx.textContent = '+';

  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.placeholder = '추가할 내용 입력';

  const addBtn = document.createElement('button');
  addBtn.className = 'x';
  addBtn.textContent = '추가';

  const commit = () => {
    const text = addInput.value.trim();
    if (!text) return;
    t.presets.push({ id: cryptoId(), text });
    addInput.value = '';
    persistTemplate();
    renderPresets();
    renderTotals();
    renderPreview();
  };
  addBtn.addEventListener('click', commit);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
  });

  add.append(addIdx, addInput, addBtn);
  wrap.appendChild(add);
}

function renderTotals(): void {
  if (!template) return;
  const total = totalCount(template);
  const n = template.presets.length;
  must('#preset-ct').textContent = `${n}개`;
  must('#totals').textContent =
    template.usePresets && n > 0
      ? `→ ${n} × ${template.repeats} = ${total}장`
      : `→ ${template.repeats}장 (시드만)`;
  const card = $('#presets-card');
  if (card) {
    // 변형 OFF면 흐리게 보이는 것만으로 끝내지 않고 inert로 실제 입력도 막는다(U06) —
    // 흐릿한데 타이핑·삭제·저장까지 되는 "비활성처럼 보이는데 동작하는" 상태를 없앤다.
    const off = !template.usePresets;
    card.style.opacity = off ? '.45' : '1';
    if (off) card.setAttribute('inert', '');
    else card.removeAttribute('inert');
  }
}

/**
 * "전개 미리보기" — 실제 조합된 프롬프트를 앞 8개만 미리 보여준다(U01).
 * 고정 부분은 `.hint`(옅게), 변형 부분은 var(--r) 강조로 구분한다.
 * 프리셋·고정 프롬프트·반복 횟수·모드가 바뀔 때마다 호출된다.
 */
function renderPreview(): void {
  if (!template) return;
  const t = template;
  const list = $('#preview-list');
  const hintEl = $('#preview-hint');
  const summaryEl = $('#preview-summary');
  if (!list) return;

  const total = totalCount(t);
  if (hintEl) hintEl.textContent = `${total}장`;

  list.innerHTML = '';
  const items = preview(t, PREVIEW_COUNT);
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '표시할 항목이 없습니다';
    list.appendChild(empty);
  }
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--soft);font-size:12.5px;line-height:1.5';

    const idx = document.createElement('span');
    idx.className = 'hint';
    idx.style.cssText = 'flex-shrink:0;font-variant-numeric:tabular-nums';
    idx.textContent = String(i + 1).padStart(2, '0');

    const text = document.createElement('span');
    const fixed = t.fixedPrompt.trim();
    const change = item.preset.text.trim();
    if (fixed) {
      const fixedSpan = document.createElement('span');
      fixedSpan.className = 'hint';
      fixedSpan.textContent = change ? `${fixed}, ` : fixed;
      text.appendChild(fixedSpan);
    }
    if (change) {
      const changeSpan = document.createElement('span');
      changeSpan.style.cssText = 'color:var(--r);font-weight:700';
      changeSpan.textContent = change;
      text.appendChild(changeSpan);
    }
    if (!fixed && !change) {
      text.textContent = '(빈 프롬프트)';
    }

    row.append(idx, text);
    list.appendChild(row);
  });

  if (summaryEl) {
    const cost = total * EST_ANLAS_PER_IMAGE;
    summaryEl.textContent = `총 ${total}장 · 예상 약 ${cost.toLocaleString()} Anlas 소모 (어림)`;
  }
}

export const batchScreen: Screen = {
  name: 'batch',

  render: () => `
    <section class="screen" data-screen="batch" hidden>
      <header class="hd sub">
        <button class="back" data-nav="home">←</button>
        <h2>배치</h2>
      </header>

      <div class="card">
        <label class="row sw-row">
          <span>
            <span class="row-ttl">변형 사용</span>
            <span class="row-sub">매 장마다 프롬프트 일부를 바꿔 가며 생성합니다</span>
          </span>
          <span class="switch" id="use-presets-sw"></span>
        </label>
        <div class="constraint-note" id="preset-constraint-note" hidden>
          시드가 고정된 상태에서는 변형을 끌 수 없습니다.
        </div>
        <div class="sw-divider"></div>
        <label class="row sw-row">
          <span>
            <span class="row-ttl">매번 새 시드</span>
            <span class="row-sub">같은 프롬프트라도 매번 다른 이미지를 생성합니다</span>
          </span>
          <span class="switch" id="random-seed-sw"></span>
        </label>
        <div class="constraint-note" id="seed-constraint-note" hidden>
          변형이 꺼진 상태에서는 시드를 고정할 수 없습니다.
        </div>
      </div>

      <div class="card">
        <div class="lbl">기본 프롬프트 <span class="hint">모든 이미지에 공통으로 들어갑니다</span></div>
        <textarea id="fixed-prompt" rows="3" placeholder="예: 1girl, masterpiece, best quality"></textarea>
      </div>

      <div class="card" id="presets-card">
        <div class="card-h">
          <span>변형 <span class="hint" id="preset-ct">0개</span></span>
          <span class="seg mini" id="mode-toggle" style="--seg-n:2">
            <span class="seg-indicator"></span>
            <button data-v="sequential" class="on">순서대로</button>
            <button data-v="random">무작위</button>
          </span>
        </div>
        <div class="hint mini" style="margin:0 0 8px">기본 프롬프트 뒤에 한 줄씩 추가됩니다 (예: smile, standing)</div>
        <div class="pset" id="presets"></div>
      </div>

      <div class="card">
        <div class="kv-line">
          <span class="kv-key">반복 횟수<button class="qmark" data-tip="변형 목록 전체를 몇 번 돌릴지 설정합니다. 변형 8개 × 반복 5 = 총 40장.">?</button></span>
          <input id="repeats" type="number" min="1" value="1">
          <span class="kv-suf hint" id="totals">→ 0장</span>
        </div>
      </div>

      <details class="card" id="preview-card">
        <summary style="cursor:pointer;font-weight:800;font-size:14px">
          전개 미리보기 <span class="hint" id="preview-hint">0장</span>
        </summary>
        <div class="hint mini" style="margin:8px 0">
          앞 ${PREVIEW_COUNT}장만 미리 보여줍니다 — 실행 전에 조합이 맞는지 확인하세요.
        </div>
        <div id="preview-list"></div>
        <div class="hint mini" id="preview-summary" style="margin-top:8px"></div>
      </details>
    </section>
  `,

  async mount() {
    template = await getTemplate();

    // 저장된 상태가 유효하지 않은 경우 교정 (usePresets=off + randomSeed=off)
    if (!template.usePresets && !template.randomSeed) {
      template.randomSeed = true;
      await setTemplate(template);
    }
    const t = template;

    const fixed = must<HTMLTextAreaElement>('#fixed-prompt');
    fixed.value = t.fixedPrompt;
    fixed.addEventListener('input', () => {
      t.fixedPrompt = fixed.value;
      persistTemplate();
      renderPreview();
    });

    bindSwitch(must('#use-presets-sw'), t.usePresets, (v) => {
      t.usePresets = v;
      persistTemplate();
      renderTotals();
      renderPreview();
      syncSeedPresetConstraint();
    });

    bindSwitch(must('#random-seed-sw'), t.randomSeed, (v) => {
      t.randomSeed = v;
      persistTemplate();
      syncSeedPresetConstraint();
    });

    const repeats = must<HTMLInputElement>('#repeats');
    repeats.value = String(t.repeats);
    repeats.addEventListener('input', () => {
      t.repeats = Math.max(1, Number(repeats.value) || 1);
      persistTemplate();
      renderTotals();
      renderPreview();
    });

    bindSeg(must('#mode-toggle'), t.mode, (v) => {
      t.mode = v as VariationMode;
      persistTemplate();
      renderPreview();
    });

    renderPresets();
    renderTotals();
    renderPreview();
    syncSeedPresetConstraint();
  },
};
