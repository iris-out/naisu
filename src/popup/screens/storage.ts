/** 다운로드 화면 — 저장 방식 · 폴더 · 파일명 템플릿 · 메타데이터 옵션. */

import {
  getSettings,
  setSettings,
  renderFilename,
  renderFolder,
  FILENAME_TOKENS,
  FOLDER_TOKENS,
  type ConflictAction,
  type DownloadMode,
  type FilenameContext,
  type ImageOps,
  type Settings,
} from '../../lib/storage';
import { opsSummary } from '../../lib/image-ops';
import { findField, type RiskLevel } from '../settings-registry';
import { $, $$, must } from '../ui/dom';
import { bindInput } from '../ui/input';
import { bindSeg } from '../ui/seg';
import { bindSwitch } from '../ui/switch';
import { flashHint } from '../ui/status';
import { riskBadge, helpLine, bindRevertScreen, refreshScreenRisk } from '../ui/field-ui';
import type { Screen } from './types';

export function labelDownloadMode(m: DownloadMode): string {
  return m === 'hardclean' ? '하드클린' : m === 'clean' ? '클린' : m === 'raw' ? '원본' : '클린+원본';
}

/** 품질 드롭다운 선택지 — 100이 원본에 가장 가깝고 60이 용량을 가장 많이 줄인다. */
const QUALITY_PRESETS = [1, 0.9, 0.8, 0.7, 0.6];

/**
 * 품질 값에 대한 설명 한두 줄 — 드롭다운 아래 헬프라인에 그대로 쓴다.
 * 하드클린의 EXIF·알파 채널 제거는 품질과 무관하게 항상 적용되므로(확인된 은닉 경로는
 * 이 둘뿐 — report_0821.md), 여기서는 화질·용량 트레이드오프만 설명한다.
 */
function qualityHelpText(q: number): string {
  if (q >= 1) return '원본에 가장 가까운 화질입니다. 용량이 가장 큽니다.';
  if (q >= 0.9) return '육안으로 거의 구분되지 않는 화질입니다. 기본값으로 추천합니다.';
  if (q >= 0.8) return '약간의 손실이 있지만 대부분 눈치채기 어렵습니다. 용량이 상당히 줄어듭니다.';
  if (q >= 0.7) return '손실이 눈에 띄기 시작합니다. 용량을 더 줄이고 싶을 때 씁니다.';
  return '화질 저하가 뚜렷합니다. 용량이 가장 작습니다.';
}

/**
 * 저장 방식 세로 리스트 — 안전한 순서대로.
 * 배지 문구는 화면 전용 표현이지만, 배지 "레벨"(ok/warn/danger)은 하드코딩하지 않고
 * settings-registry의 `downloadMode` risk()를 그 모드로 가정해 물어봐서 정한다.
 * (registry의 risk()는 s.downloadMode만 보고 판단하므로 다른 필드는 상관없다 — DEFAULTS를
 * 베이스로 모드만 바꿔 넣어도 항상 같은 결과가 나온다.)
 */
const MODE_ORDER: { value: DownloadMode; label: string; desc: string; badge: string }[] = [
  {
    value: 'hardclean',
    label: '하드클린',
    desc: '픽셀을 다시 그려 재인코딩(기본 WebP, 아래 출력 포맷에서 JPEG로도 가능). 알파 채널이 사라져 은닉 데이터까지 제거',
    badge: '가장 안전',
  },
  {
    value: 'clean',
    label: '클린',
    desc: 'EXIF + 알파 LSB 제거. 화질 그대로(.webp)',
    badge: '보통',
  },
  {
    value: 'both',
    label: '클린 + 원본',
    desc: '클린본과 원본을 함께 저장',
    badge: '보통',
  },
  {
    value: 'raw',
    label: '원본',
    desc: '프롬프트·시드가 그대로 박힌 채 저장',
    badge: '그대로 남음',
  },
];

function modeRiskLevel(mode: DownloadMode): RiskLevel {
  const field = findField('downloadMode');
  // getSettings()의 DEFAULTS를 그대로 쓰지 않고 최소 필드만 캐스팅하는 이유:
  // risk()는 실제로 s.downloadMode만 읽으므로 나머지 필드는 어떤 값이어도 무방하다.
  return field?.risk?.({ downloadMode: mode } as Settings)?.level ?? 'ok';
}

/** 파일명 프리셋 — 대부분은 토큰 13개를 직접 조합하지 않는다. */
const FILENAME_PRESETS: { value: string; label: string; template?: string }[] = [
  { value: 'date_seed', label: '날짜_시드', template: '{datetime}_{seed}' },
  { value: 'model_seed', label: '모델_시드', template: '{model}_{seed}' },
  { value: 'custom', label: '직접' },
];

function presetForTemplate(tpl: string): string {
  return FILENAME_PRESETS.find((p) => p.template === tpl)?.value ?? 'custom';
}

/** 파일명/폴더 미리보기에 쓰는 그럴듯한 샘플 컨텍스트. */
const PREVIEW_CTX: FilenameContext = {
  seed: 1234567,
  model: 'nai-diffusion-4-5',
  w: 832,
  h: 1216,
  steps: 23,
  sampler: 'k_euler_ancestral',
  idx: 1,
  batch: '20260822_190053',
  template: 'template_01',
};

const KEEP_COLOR_HELP_DEFAULT = 'ICC 프로파일을 보존합니다. 보통은 꺼도 됩니다.';
const KEEP_COLOR_HELP_LOCKED = '하드클린은 캔버스로 다시 그려 재인코딩하므로(JPEG든 WebP든) 프로파일이 남지 않습니다.';

/**
 * 폴더 한 칸 ↔ 두 필드 변환 규칙.
 *
 * 화면에는 "naisu/{batch}" 처럼 한 입력만 두지만, 러너(runner.ts)는 여전히
 * downloadFolder("naisu")와 batchFolderTemplate("{batch}")를 별개 설정 키로 읽는다.
 * 그래서 저장 직전에 첫 '/' 앞을 downloadFolder, 뒤(남은 전체, '/'가 더 있어도 통째로)를
 * batchFolderTemplate으로 쪼갠다. '/'가 없으면 배치 하위 폴더 없이 최상위 폴더만 지정한
 * 것으로 본다. 읽어서 보여줄 때는 반대로 두 값을 '/'로 이어 붙인다(하위 폴더가
 * 비어 있으면 이어 붙이지 않는다).
 */
function splitFolderCombo(v: string): { downloadFolder: string; batchFolderTemplate: string } {
  const idx = v.indexOf('/');
  if (idx === -1) return { downloadFolder: v, batchFolderTemplate: '' };
  return { downloadFolder: v.slice(0, idx), batchFolderTemplate: v.slice(idx + 1) };
}

function joinFolderCombo(downloadFolder: string, batchFolderTemplate: string): string {
  return batchFolderTemplate ? `${downloadFolder}/${batchFolderTemplate}` : downloadFolder;
}

/** 세로 라디오 리스트(.modes/.mode) 바인딩 — bindSeg는 가로 세그 전용 마크업이라 재사용할 수 없다. */
function bindModeList(
  container: HTMLElement,
  initial: DownloadMode,
  onChange: (v: DownloadMode) => unknown,
): (v: DownloadMode) => void {
  const btns = Array.from(container.querySelectorAll<HTMLButtonElement>('.mode'));

  const activate = (v: DownloadMode) => {
    btns.forEach((b) => {
      const isOn = b.dataset.v === v;
      b.setAttribute('aria-checked', String(isOn));
      b.tabIndex = isOn ? 0 : -1;
    });
  };

  const selectByIndex = (idx: number) => {
    const b = btns[idx];
    if (!b) return;
    const v = b.dataset.v as DownloadMode;
    activate(v);
    b.focus();
    void onChange(v);
  };

  btns.forEach((b, i) => {
    b.addEventListener('click', () => {
      const v = b.dataset.v as DownloadMode;
      activate(v);
      void onChange(v);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        selectByIndex((i + 1) % btns.length);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        selectByIndex((i - 1 + btns.length) % btns.length);
      }
    });
  });

  activate(initial);
  return activate;
}

/** 하드클린 모드에서는 색상 프로파일 유지 스위치가 무의미하므로 잠그고 사유를 helpLine()으로 상시 노출합니다. */
function updateColorProfileLock(mode: DownloadMode): void {
  const sw = $('#keep-color-sw');
  const help = $('#keep-color-help');
  if (!sw || !help) return;
  const locked = mode === 'hardclean';
  sw.classList.toggle('locked', locked);
  sw.setAttribute('aria-disabled', String(locked));
  help.innerHTML = helpLine(locked ? KEEP_COLOR_HELP_LOCKED : KEEP_COLOR_HELP_DEFAULT);
}

/**
 * 현재 선택된 저장 방식 + 출력 포맷에 맞춰 파일 확장자를 붙인다.
 * raw는 후처리가 절대 적용되지 않으므로(규칙은 service-worker.ts가 강제) 포맷과
 * 무관하게 항상 .webp. 그 외 모드는 출력 포맷이 JPEG일 때만 .jpg, 아니면 .webp.
 */
function extFor(mode: DownloadMode, format: ImageOps['format']): string {
  if (mode === 'raw') return '.webp';
  return format === 'jpg' ? '.jpg' : '.webp';
}

function updateFolderPreview(): void {
  const out = $('#folder-preview');
  const comboEl = $<HTMLInputElement>('#folder-combo');
  if (!out || !comboEl) return;
  const { downloadFolder, batchFolderTemplate } = splitFolderCombo(comboEl.value);
  const rendered = renderFolder({ downloadFolder, batchFolderTemplate }, PREVIEW_CTX);
  out.textContent = `→ ${rendered}/`;
}

function updateFilenamePreview(mode: DownloadMode, format: ImageOps['format']): void {
  const out = $('#filename-preview');
  const tplEl = $<HTMLInputElement>('#filename-tpl');
  if (!out || !tplEl) return;
  out.textContent = `→ ${renderFilename(tplEl.value, PREVIEW_CTX)}${extFor(mode, format)}`;
}

export const storageScreen: Screen = {
  name: 'storage',

  render: () => {
    const filenameChips = FILENAME_TOKENS.map((t) => `<span>${t}</span>`).join('');
    const folderChips = FOLDER_TOKENS.map((t) => `<span>${t}</span>`).join('');
    const modeItems = MODE_ORDER.map(
      (m) => `
        <button type="button" class="mode" role="radio" aria-checked="false" data-v="${m.value}">
          <span class="dot"></span>
          <span class="mode-t"><b>${m.label}</b><span>${m.desc}</span></span>
          ${riskBadge(modeRiskLevel(m.value), m.badge)}
        </button>`,
    ).join('');

    return `
    <section class="screen" data-screen="storage" hidden>
      <header class="hd sub">
        <button class="back" data-nav="home">←</button>
        <h2>다운로드</h2>
        <span class="screen-head-right">
          <span id="storage-risk"></span>
          <button class="revert" id="storage-revert">↺ 기본값</button>
        </span>
      </header>

      <div class="lbl">저장 방식 — 위로 갈수록 안전</div>
      <div class="modes" id="dl-mode-list" role="radiogroup" aria-label="저장 방식">${modeItems}</div>

      <div class="card">
        <div class="lbl">품질</div>
        <select id="dl-quality">
          ${QUALITY_PRESETS.map((q) => `<option value="${q}">${Math.round(q * 100)}</option>`).join('')}
        </select>
        <div id="quality-help"></div>
        <div class="lbl" style="margin-top:8px">출력 포맷</div>
        <div class="seg" id="dl-format" role="radiogroup" style="--seg-n:3">
          <span class="seg-indicator"></span>
          <button data-v="auto">NAI 기본 (WebP)</button>
          <button data-v="jpg">JPEG</button>
          <button data-v="webp">WebP</button>
        </div>
      </div>

      <div class="card">
        <label class="full">
          <span class="lbl">저장 폴더</span>
          <input id="folder-combo" type="text" value="naisu/{batch}">
        </label>
        <details class="tok-fold">
          <summary>쓸 수 있는 폴더 토큰 ${FOLDER_TOKENS.length}개</summary>
          <div class="tok" id="folder-tokens">${folderChips}</div>
        </details>
        <div class="preview-line" id="folder-preview"></div>

        <label class="full" style="margin-top:8px">
          <span class="lbl">파일 이름</span>
        </label>
        <div class="seg" id="filename-preset" role="radiogroup" style="--seg-n:3">
          <span class="seg-indicator"></span>
          <button data-v="date_seed">날짜_시드</button>
          <button data-v="model_seed">모델_시드</button>
          <button data-v="custom">직접</button>
        </div>
        <input id="filename-tpl" type="text" value="{datetime}_{seed}" style="margin-top:8px">
        <details class="tok-fold">
          <summary>쓸 수 있는 토큰 ${FILENAME_TOKENS.length}개</summary>
          <div class="tok" id="filename-tokens">${filenameChips}</div>
        </details>
        <div class="preview-line" id="filename-preview"></div>
      </div>

      <div class="card">
        <div class="lbl">메타데이터</div>
        <label class="row sw-row">
          <span>
            <span class="row-ttl">색상 프로파일 유지</span>
          </span>
          <span class="switch" id="keep-color-sw"></span>
        </label>
        <div id="keep-color-help"></div>
      </div>

      <div class="card">
        <div class="lbl">저장 동작</div>
        <div class="lbl" style="margin-top:4px">같은 이름이 이미 있으면</div>
        <div class="seg" id="conflict-seg" role="radiogroup" style="--seg-n:3">
          <span class="seg-indicator"></span>
          <button data-v="uniquify">번호 붙이기</button>
          <button data-v="overwrite">덮어쓰기</button>
          <button data-v="prompt">매번 묻기</button>
        </div>
        <div id="conflict-help"></div>

        <label class="row sw-row" style="margin-top:8px">
          <span><span class="row-ttl">배치 매니페스트 저장</span></span>
          <span class="switch" id="manifest-sw"></span>
        </label>
        <div id="manifest-help"></div>

        <label class="full" style="margin-top:8px">
          <span class="lbl">원본 캐시 장수</span>
          <input id="cache-limit" type="number" min="0" max="200" step="1">
        </label>
        <div id="cache-help"></div>
      </div>

      <div class="card">
        <button class="m-row" data-nav="output" type="button">
          <span class="m-txt">
            <span class="m-ttl">저장 후처리</span>
            <span class="m-sub">크기 · 품질 · 비율 · 워터마크 · 프로필</span>
          </span>
          <span class="m-val" id="storage-ops-val">—</span>
          <span class="m-ch">›</span>
        </button>
      </div>
    </section>
  `;
  },

  async mount() {
    const s = await getSettings();
    let currentMode: DownloadMode = s.downloadMode;
    let currentFormat: ImageOps['format'] = s.imageOps.format;

    // bindModeList/bindSeg는 버튼에 직접 이벤트 리스너를 붙이는 방식이라, 되돌리기 때마다
    // 다시 호출하면 리스너가 계속 누적된다(클릭 한 번에 저장이 여러 번 일어남). 그래서
    // 최초 1회만 바인딩하고, 이후에는 바인딩이 돌려주는 activate 함수로 표시값만 맞춘다.
    const activateMode = bindModeList(must('#dl-mode-list'), s.downloadMode, async (v) => {
      currentMode = v;
      updateColorProfileLock(v);
      updateFilenamePreview(currentMode, currentFormat);
      await setSettings({ downloadMode: v });
      flashHint('저장됨');
    });
    updateColorProfileLock(s.downloadMode);

    const activateFormat = bindSeg(must('#dl-format'), s.imageOps.format, async (v) => {
      currentFormat = v as ImageOps['format'];
      updateFilenamePreview(currentMode, currentFormat);
      const fresh = await getSettings();
      await setSettings({ imageOps: { ...fresh.imageOps, format: currentFormat } });
      flashHint('저장됨');
    });

    const qualitySelect = must<HTMLSelectElement>('#dl-quality');
    const qualityHelp = must('#quality-help');
    const refreshQualityHelp = (v: number): void => {
      qualityHelp.innerHTML = helpLine(qualityHelpText(v));
    };
    qualitySelect.value = String(s.imageOps.quality);
    refreshQualityHelp(s.imageOps.quality);
    qualitySelect.addEventListener('change', async () => {
      const q = Number(qualitySelect.value);
      refreshQualityHelp(q);
      const fresh = await getSettings();
      await setSettings({ imageOps: { ...fresh.imageOps, quality: q } });
      flashHint('저장됨');
    });

    bindInput('#folder-combo', joinFolderCombo(s.downloadFolder, s.batchFolderTemplate), (v) => {
      const parts = splitFolderCombo(v);
      return setSettings(parts);
    });
    must<HTMLInputElement>('#folder-combo').addEventListener('input', updateFolderPreview);
    updateFolderPreview();

    const initialPreset = presetForTemplate(s.filenameTemplate);
    const filenameInput = must<HTMLInputElement>('#filename-tpl');
    filenameInput.hidden = initialPreset !== 'custom';
    const activatePreset = bindSeg(must('#filename-preset'), initialPreset, (v) => {
      const preset = FILENAME_PRESETS.find((p) => p.value === v);
      if (!preset) return;
      filenameInput.hidden = preset.value !== 'custom';
      if (preset.template !== undefined) {
        filenameInput.value = preset.template;
        filenameInput.dispatchEvent(new Event('input'));
        void setSettings({ filenameTemplate: preset.template });
        flashHint('저장됨');
      } else {
        filenameInput.focus();
      }
    });

    bindInput('#filename-tpl', s.filenameTemplate, (v) => setSettings({ filenameTemplate: v }));
    filenameInput.addEventListener('input', () => updateFilenamePreview(currentMode, currentFormat));
    updateFilenamePreview(currentMode, currentFormat);

    $$('#filename-tokens span').forEach((chip) =>
      chip.addEventListener('click', () => {
        filenameInput.value += chip.textContent ?? '';
        filenameInput.dispatchEvent(new Event('input'));
      }),
    );
    $$('#folder-tokens span').forEach((chip) =>
      chip.addEventListener('click', () => {
        const input = must<HTMLInputElement>('#folder-combo');
        input.value += chip.textContent ?? '';
        input.dispatchEvent(new Event('input'));
      }),
    );

    // switch.ts는 값 갱신용 API를 따로 내보내지 않으므로(클릭 시 내부적으로만 토글),
    // 되돌리기 후 표시값 동기화는 bindSwitch가 내부에서 하는 것과 같은 class/attr만 맞춰준다
    // (리스너를 다시 붙이면 안 되므로 bindSwitch를 재호출하지 않는다).
    const syncSwitch = (v: boolean) => {
      const sw = must('#keep-color-sw');
      sw.classList.toggle('on', v);
      sw.setAttribute('aria-checked', String(v));
    };
    bindSwitch(must('#keep-color-sw'), s.keepColorProfile, (v) =>
      setSettings({ keepColorProfile: v }),
    );

    const refreshAll = async () => {
      const fresh = await getSettings();
      currentMode = fresh.downloadMode;
      activateMode(fresh.downloadMode);
      updateColorProfileLock(fresh.downloadMode);
      currentFormat = fresh.imageOps.format;
      activateFormat(fresh.imageOps.format);
      qualitySelect.value = String(fresh.imageOps.quality);
      refreshQualityHelp(fresh.imageOps.quality);
      const comboEl = must<HTMLInputElement>('#folder-combo');
      comboEl.value = joinFolderCombo(fresh.downloadFolder, fresh.batchFolderTemplate);
      updateFolderPreview();
      const preset = presetForTemplate(fresh.filenameTemplate);
      activatePreset(preset);
      filenameInput.value = fresh.filenameTemplate;
      filenameInput.hidden = preset !== 'custom';
      updateFilenamePreview(currentMode, currentFormat);
      syncSwitch(fresh.keepColorProfile);
      await refreshScreenRisk($('#storage-risk'), 'storage');
    };

    // ---- 저장 동작 (이름 충돌 · 매니페스트 · 원본 캐시) ----
    const conflictHelp = must('#conflict-help');
    const syncConflictHelp = (v: ConflictAction): void => {
      conflictHelp.innerHTML = helpLine(
        v === 'uniquify'
          ? '기존 파일을 남기고 이름 뒤에 (1), (2)를 붙입니다.'
          : v === 'overwrite'
            ? '같은 이름의 기존 파일을 지웁니다 — 배치에서 파일명이 겹치면 결과가 한 장만 남을 수 있습니다.'
            : '저장할 때마다 브라우저 저장 대화상자가 뜹니다. 자동 배치에는 맞지 않습니다.',
      );
    };
    bindSeg(must('#conflict-seg'), s.conflictAction, async (v) => {
      await setSettings({ conflictAction: v as ConflictAction });
      syncConflictHelp(v as ConflictAction);
      flashHint('저장됨');
    });
    syncConflictHelp(s.conflictAction);

    must('#manifest-help').innerHTML = helpLine(
      '배치 폴더에 프롬프트·시드 목록 CSV를 하나 남깁니다. 클린 저장은 이미지에서 그 정보를 지우므로, 나중에 재현하려면 이 파일이 필요합니다.',
    );
    bindSwitch(must('#manifest-sw'), s.writeManifest, (v) => setSettings({ writeManifest: v }));

    const cacheHelp = must('#cache-help');
    const syncCacheHelp = (n: number): void => {
      cacheHelp.innerHTML = helpLine(
        n <= 0
          ? '0이면 원본을 보관하지 않습니다 — 패널의 "다시 저장"과 "이미지 복사"를 쓸 수 없습니다.'
          : `최근 ${n}장의 원본을 브라우저에 보관합니다. 하드클린이 실패했을 때 다시 저장할 수 있는 유일한 방법입니다(한 장당 약 1~3MB).`,
      );
    };
    bindInput('#cache-limit', String(s.cacheLimit), async (v) => {
      const n = Math.max(0, Math.min(200, Math.round(Number(v) || 0)));
      await setSettings({ cacheLimit: n });
      syncCacheHelp(n);
      flashHint('저장됨');
    });
    syncCacheHelp(s.cacheLimit);

    bindRevertScreen(must('#storage-revert'), 'storage', refreshAll);
    await refreshScreenRisk($('#storage-risk'), 'storage');
  },

  async enter() {
    // 후처리 화면에서 값을 바꾸고 돌아왔을 때 요약이 옛 값으로 남아 있지 않게 한다.
    const el = $('#storage-ops-val');
    if (!el) return;
    const fresh = await getSettings();
    el.textContent = opsSummary(fresh.imageOps) || '없음';
  },
};
