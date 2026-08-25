/**
 * 패널 팝오버 — 상태 칩·저장 메뉴·더보기가 전부 이 하나를 돌려 쓴다.
 *
 * 왜 팝오버인가: A안의 핵심은 "팝업을 열어야만 바꿀 수 있던 설정을 손이 닿는 곳으로"다.
 * 그런데 280px 패널 안에 설정 UI를 상시로 펼쳐 두면 패널이 다시 뚱뚱해진다.
 * 그래서 값은 칩으로 상시 보여 주고, 편집은 필요할 때만 뜨는 팝오버에서 한다.
 *
 * 아이콘 레일(56px)에서는 칩 세 개가 들어갈 자리가 없으므로 ⚙ 하나로 접고,
 * 같은 팝오버에 세 가지를 한 번에 담아 보여 준다(quickSettingsContent) —
 * "레일의 컴팩트를 유지하면서 간단한 설정은 팝업으로 딱" 이 요구를 만족시키는 자리.
 */

import { icon, type IconName } from '../lib/icons';
import { FILENAME_TOKENS, getSettings, setSettings, type DownloadMode, type Settings } from '../lib/storage';
import type { SaveOverride } from './panel-types';

/** 짧은 이름 — 상태 칩·결과 줄처럼 폭이 좁은 자리 */
export const MODE_LABEL: Record<DownloadMode, string> = {
  hardclean: '하드클린',
  clean: '클린',
  raw: '원본',
  both: '둘 다',
};

/**
 * 무엇을 하는지 드러내는 이름 — 메뉴처럼 폭에 여유가 있는 자리.
 * '둘 다'는 무엇과 무엇인지 안 드러나고, 조사가 붙으면 "둘 다으로"처럼 어색해진다.
 * 여기 값들은 전부 받침으로 끝나므로 "…으로"가 항상 자연스럽다.
 */
const MODE_LONG_LABEL: Record<DownloadMode, string> = {
  hardclean: '하드클린',
  clean: '클린',
  raw: '원본',
  both: '클린 + 원본',
};

/** "이번 한 장만" 메뉴 항목 문구 — 템플릿으로 만들면 both에서 조사가 깨진다. */
const MODE_MENU_LABEL: Record<DownloadMode, string> = {
  hardclean: '하드클린으로 이번 한 장',
  clean: '클린으로 이번 한 장',
  raw: '원본으로 이번 한 장',
  both: '클린 + 원본 각각 한 장씩',
};

/** 메뉴 항목의 보조 설명 — 라벨이 이미 말한 것을 되풀이하지 않는다. */
const MODE_MENU_HINT: Record<DownloadMode, string> = {
  hardclean: '픽셀을 다시 그려 WebP로 재인코딩',
  clean: 'EXIF와 알파 채널 은닉 데이터 제거',
  raw: '아무것도 지우지 않음',
  both: '파일 2개 · 원본에는 _raw 접미사',
};

/** 모드별 아이콘 — 뭘 하는지 한눈에 구분되도록. */
const MODE_MENU_ICON: Record<DownloadMode, IconName> = {
  hardclean: 'flame',
  clean: 'shield',
  raw: 'image',
  both: 'copy',
};

const MODE_HELP: Record<DownloadMode, string> = {
  hardclean: '픽셀을 다시 그려 WebP로 재인코딩합니다. EXIF와 알파 채널 은닉은 품질과 무관하게 항상 제거되고, 대신 투명도가 사라집니다.',
  clean: 'EXIF와 알파 채널 은닉 데이터를 지웁니다. WebP 그대로, 무손실입니다.',
  raw: '아무것도 지우지 않습니다. 프롬프트·시드가 파일에 남습니다.',
  both: '클린 파일과 원본 파일을 각각 저장합니다. 원본에는 _raw 접미사가 붙습니다.',
};

let popEl: HTMLElement | null = null;
let onCloseCb: (() => void) | null = null;

/** 지금 열려 있는 팝오버의 이름 — 같은 앵커를 다시 누르면 닫히게(토글) 하기 위한 것. */
let openKey: string | null = null;

export function isPopoverOpen(key?: string): boolean {
  return key === undefined ? openKey !== null : openKey === key;
}

export function closePopover(): void {
  if (!popEl) return;
  resizeObs?.disconnect();
  resizeObs = null;
  popEl.hidden = true;
  popEl.innerHTML = '';
  openKey = null;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onEsc, true);
  onCloseCb?.();
  onCloseCb = null;
}

function onOutside(e: MouseEvent): void {
  if (!popEl || popEl.hidden) return;
  const t = e.target as Node;
  if (popEl.contains(t)) return;
  // 앵커 자신을 누른 경우는 각 호출부의 토글 로직이 처리한다 — 여기서 닫으면 두 번 처리되어 다시 열린다.
  if ((t as HTMLElement).closest?.('[data-pop-anchor]')) return;
  closePopover();
}

function onEsc(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  closePopover();
}

/** 패널 루트 안에 팝오버 컨테이너를 한 번 만들어 둔다. */
export function mountPopover(root: HTMLElement): void {
  popEl = document.createElement('div');
  popEl.className = 'np-pop';
  popEl.hidden = true;
  popEl.setAttribute('role', 'dialog');
  root.appendChild(popEl);
}

export function unmountPopover(): void {
  closePopover();
  popEl?.remove();
  popEl = null;
}

/**
 * 앵커 기준으로 팝오버를 띄운다.
 *
 * 패널은 화면 어느 모서리에나 있을 수 있으므로(드래그 + 모서리 스냅), 위/아래·왼쪽/오른쪽을
 * 뷰포트에 맞춰 뒤집는다. 좌표는 패널 루트 기준(부모가 position:fixed)이라 스크롤과 무관하다.
 */
export function openPopover(
  key: string,
  anchor: HTMLElement,
  build: (body: HTMLElement, close: () => void) => void,
  onClose?: () => void,
): void {
  if (!popEl) return;
  if (openKey === key) {
    closePopover();
    return;
  }
  closePopover();
  openKey = key;
  onCloseCb = onClose ?? null;

  popEl.hidden = false;
  popEl.innerHTML = '';
  build(popEl, closePopover);
  place(anchor);

  // ⚠ 내용을 채우는 쪽이 비동기다(quickSettingsContent는 getSettings를 await한다).
  //   그래서 처음 place()는 **빈 상자 높이**로 계산된다 — 실측: 레일 모드에서 팝오버
  //   아래쪽("파일 이름" 칸)이 화면 밖으로 잘려 손이 닿지 않았다.
  //   내용이 들어와 크기가 바뀌면 다시 배치한다.
  resizeObs?.disconnect();
  resizeObs = new ResizeObserver(() => place(anchor));
  resizeObs.observe(popEl);

  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onEsc, true);
  popEl.querySelector<HTMLElement>('input,button,[tabindex]')?.focus();
}

let resizeObs: ResizeObserver | null = null;

/** 뷰포트 안으로 밀어 넣기 (양쪽 8px 여백 유지). */
function clamp(want: number, size: number, limit: number): number {
  return Math.min(Math.max(8, want), Math.max(8, limit - size - 8));
}

/**
 * 앵커 기준 위치 계산 — 뷰포트 밖으로 나가지 않도록 양방향으로 클램프한다.
 *
 * 카드 모드는 앵커 아래(공간이 없으면 위)에 붙인다.
 * **레일 모드는 옆으로 뺀다** — 폭이 56px뿐이라 위/아래에 두면 팝오버가 레일을 통째로
 * 덮어서, 정작 눌러야 할 버튼(▶ · ⭳ · ■)이 가려진다(2026-08-24 보고).
 * 로그 펼침이 이미 `right: calc(100% + 8px)`로 같은 방식을 쓰고 있다.
 */
function place(anchor: HTMLElement): void {
  if (!popEl || popEl.hidden) return;
  const rootRect =
    (popEl.offsetParent as HTMLElement | null)?.getBoundingClientRect() ??
    popEl.parentElement!.getBoundingClientRect();
  const aRect = anchor.getBoundingClientRect();
  const pw = popEl.offsetWidth;
  const ph = popEl.offsetHeight;
  const isRail = popEl.parentElement?.classList.contains('rail') === true;

  let absLeft: number;
  let absTop: number;

  if (isRail) {
    // 가로: 레일 **패널 전체**를 기준으로 옆에 붙인다. 앵커(버튼)를 기준으로 잡으면
    // 버튼이 레일 안쪽으로 들여져 있는 만큼 팝오버가 레일을 파고든다
    // (실측: ⋯ 버튼 기준으로 계산했을 때 6px 겹침).
    const GAP = 8;
    const toLeft = rootRect.left - pw - GAP;
    absLeft = toLeft >= 8 ? toLeft : rootRect.right + GAP;
    // 세로: 앵커와 같은 높이에서 시작하되 화면 안으로
    absTop = aRect.top;
  } else {
    // 세로: 앵커 아래가 좁으면 위로 뒤집는다
    const belowSpace = window.innerHeight - aRect.bottom;
    const placeAbove = belowSpace < ph + 12 && aRect.top > ph + 12;
    absTop = placeAbove ? aRect.top - ph - 6 : aRect.bottom + 6;
    // 가로: 앵커 왼쪽 정렬이 기본, 오른쪽으로 넘치면 오른쪽 정렬
    absLeft = aRect.left;
    if (absLeft + pw > window.innerWidth - 8) absLeft = aRect.right - pw;
  }

  popEl.style.left = `${Math.round(clamp(absLeft, pw, window.innerWidth) - rootRect.left)}px`;
  popEl.style.top = `${Math.round(clamp(absTop, ph, window.innerHeight) - rootRect.top)}px`;
}

// ---------------------------------------------------------------------------
// 팝오버 내용 만들기 — 전부 순수 DOM (프로젝트 컨벤션: UI 프레임워크 없음)
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function sectionTitle(body: HTMLElement, text: string): void {
  body.appendChild(el('div', 'pop-sec', text));
}

/** 저장 방식 4종 세그먼트 + 설명 한 줄. onPick은 즉시 반영(설정 저장)까지 담당. */
export function modeSegment(
  current: DownloadMode,
  onPick: (m: DownloadMode) => void,
): HTMLElement {
  const wrap = el('div', 'pop-seg');
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', '저장 방식');
  const help = el('div', 'pop-help', MODE_HELP[current]);
  const modes: DownloadMode[] = ['hardclean', 'clean', 'raw', 'both'];
  for (const m of modes) {
    const b = el('button', m === current ? 'on' : '', MODE_LABEL[m]);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(m === current));
    b.addEventListener('mouseenter', () => (help.textContent = MODE_HELP[m]));
    b.addEventListener('focus', () => (help.textContent = MODE_HELP[m]));
    b.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((x) => {
        x.classList.remove('on');
        x.setAttribute('aria-checked', 'false');
      });
      b.classList.add('on');
      b.setAttribute('aria-checked', 'true');
      help.textContent = MODE_HELP[m];
      onPick(m);
    });
    wrap.appendChild(b);
  }
  const box = el('div');
  box.appendChild(wrap);
  box.appendChild(help);
  return box;
}

/** 라벨 + 텍스트 입력 한 줄. 값은 입력할 때마다 즉시 저장한다(팝업과 같은 규칙). */
function textField(
  label: string,
  value: string,
  placeholder: string,
  onInput: (v: string) => void,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = el('label', 'pop-field');
  row.appendChild(el('span', 'k', label));
  const input = el('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.addEventListener('input', () => onInput(input.value));
  row.appendChild(input);
  return { row, input };
}

/**
 * 칩 하나를 눌렀을 때 뜨는 내용. field에 따라 저장 방식 / 폴더 / 파일명 중 하나만 보여 준다.
 * 레일 모드에서는 field='all'로 세 가지를 한 번에 담는다.
 */
export async function quickSettingsContent(
  body: HTMLElement,
  field: 'mode' | 'folder' | 'name' | 'all',
  onChanged: () => void,
): Promise<void> {
  const s = await getSettings();
  const save = async (patch: Partial<Settings>): Promise<void> => {
    await setSettings(patch);
    onChanged();
  };

  if (field === 'mode' || field === 'all') {
    sectionTitle(body, '저장 방식');
    body.appendChild(modeSegment(s.downloadMode, (m) => void save({ downloadMode: m })));
  }

  if (field === 'folder' || field === 'all') {
    sectionTitle(body, '저장 폴더');
    const { row } = textField('폴더', s.downloadFolder, 'naisu', (v) => void save({ downloadFolder: v }));
    body.appendChild(row);
    const { row: sub } = textField('배치 하위', s.batchFolderTemplate, '{batch} — 비우면 안 만듦', (v) =>
      void save({ batchFolderTemplate: v }),
    );
    body.appendChild(sub);
  }

  if (field === 'name' || field === 'all') {
    sectionTitle(body, '파일 이름');
    const { row, input } = textField('이름', s.filenameTemplate, '{datetime}_{seed}', (v) =>
      void save({ filenameTemplate: v }),
    );
    body.appendChild(row);
    const chips = el('div', 'pop-tokens');
    for (const t of FILENAME_TOKENS) {
      const c = el('button', '', t);
      c.type = 'button';
      c.title = `${t}를 파일 이름에 넣습니다`;
      c.addEventListener('click', () => {
        // 커서 위치에 끼워 넣는다 — 항상 끝에 붙이면 {datetime}_{seed} 같은 조합을 고치기 번거롭다
        const at = input.selectionStart ?? input.value.length;
        input.value = `${input.value.slice(0, at)}${t}${input.value.slice(input.selectionEnd ?? at)}`;
        input.setSelectionRange(at + t.length, at + t.length);
        input.focus();
        void save({ filenameTemplate: input.value });
      });
      chips.appendChild(c);
    }
    body.appendChild(chips);
  }
}

/**
 * 그리드 선택 저장 — NAI가 한 번에 만든 2~4장 중 원하는 것만 고른다.
 *
 * 지금까지 수동 저장은 그리드를 찾으면 **전부** 저장했다. 4장 중 2번만 원할 때
 * 방법이 아예 없었던 것이 A안 진단의 5번(이미지를 다루는 면이 없다)의 가장 구체적인 증상이다.
 * 자동 배치에는 붙이지 않는다 — 무인 실행 중에 사람이 고를 수 없기 때문.
 */
export function gridPickerContent(
  body: HTMLElement,
  items: Array<{ src: string; label: string }>,
  onConfirm: (indices: number[]) => void,
  close: () => void,
): void {
  sectionTitle(body, `그리드 ${items.length}장 — 저장할 것 고르기`);
  const grid = el('div', 'pop-grid');
  const checks: HTMLInputElement[] = [];

  items.forEach((item, i) => {
    const cell = el('label', 'pop-cell');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.setAttribute('aria-label', `${i + 1}번 이미지 저장`);
    checks.push(cb);
    const img = el('img');
    img.src = item.src;
    img.alt = item.label;
    img.loading = 'lazy';
    const tag = el('span', 'idx', String(i + 1));
    cell.append(cb, img, tag);
    cell.addEventListener('change', () => cell.classList.toggle('off', !cb.checked));
    grid.appendChild(cell);
  });
  body.appendChild(grid);

  const actions = el('div', 'pop-actions');
  const toggle = el('button', 'ghost', '전체 해제');
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    const anyOn = checks.some((c) => c.checked);
    checks.forEach((c) => {
      c.checked = !anyOn;
      c.closest('.pop-cell')?.classList.toggle('off', !c.checked);
    });
    toggle.textContent = anyOn ? '전체 선택' : '전체 해제';
    sync();
  });

  const go = el('button', 'pri');
  go.type = 'button';
  const sync = (): void => {
    const n = checks.filter((c) => c.checked).length;
    go.textContent = n === items.length ? `전부 저장 (${n}장)` : `선택 저장 (${n}장)`;
    go.disabled = n === 0;
  };
  go.addEventListener('click', () => {
    const picked = checks.map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0);
    if (picked.length === 0) return;
    onConfirm(picked);
  });
  grid.addEventListener('change', sync);
  sync();

  const cancel = el('button', 'ghost', '취소');
  cancel.type = 'button';
  cancel.addEventListener('click', close);

  actions.append(toggle, cancel, go);
  body.appendChild(actions);
  // 전부 저장이 기본 동작 — 대부분은 그대로 Enter만 누르면 예전과 같은 결과가 된다
  queueMicrotask(() => go.focus());
}

export interface MenuItem {
  label: string;
  /** 왼쪽 아이콘 (lib/icons.ts 이름) */
  iconName?: Parameters<typeof icon>[0];
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onPick(): void;
}

/** 구분선 */
export const MENU_SEP = Symbol('sep');
export type MenuRow = MenuItem | typeof MENU_SEP;

export function menuContent(body: HTMLElement, rows: MenuRow[], close: () => void): void {
  const list = el('div', 'pop-menu');
  list.setAttribute('role', 'menu');
  for (const row of rows) {
    if (row === MENU_SEP) {
      list.appendChild(el('div', 'pop-sep'));
      continue;
    }
    const b = el('button', row.danger ? 'danger' : '');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.disabled = row.disabled === true;
    if (row.iconName) {
      const ic = el('span', 'ic');
      ic.innerHTML = icon(row.iconName, 14);
      b.appendChild(ic);
    }
    const txt = el('span', 'lbl');
    txt.appendChild(el('span', 't', row.label));
    if (row.hint) txt.appendChild(el('span', 'h', row.hint));
    b.appendChild(txt);
    b.addEventListener('click', () => {
      close();
      row.onPick();
    });
    list.appendChild(b);
  }
  body.appendChild(list);
}

/**
 * ⭳ 옆 ▾ 를 눌렀을 때의 "이번 한 장만 다르게" 메뉴.
 * 여기서 고른 값은 전역 설정을 바꾸지 않고 그 한 번의 저장에만 실린다.
 */
export function saveMenuRows(current: DownloadMode, onPick: (o: SaveOverride) => void): MenuRow[] {
  const rows: MenuRow[] = [
    {
      label: `기본 설정으로 (${MODE_LONG_LABEL[current]})`,
      iconName: 'download',
      onPick: () => onPick({}),
    },
    MENU_SEP,
  ];
  for (const m of ['hardclean', 'clean', 'raw', 'both'] as DownloadMode[]) {
    if (m === current) continue;
    rows.push({
      label: MODE_MENU_LABEL[m],
      iconName: MODE_MENU_ICON[m],
      hint: MODE_MENU_HINT[m],
      onPick: () => onPick({ mode: m }),
    });
  }
  return rows;
}
