/**
 * chrome.storage.local 얇은 래퍼.
 * 키마다 기본값을 알고 있어서 처음 호출 시에도 안전하게 값을 돌려줍니다.
 *
 * 저장 키는 아래 STORAGE_KEYS 한 곳에만 정의합니다 — 화면/레인마다 문자열을 직접
 * 쓰면 초기화 대상에서 빠지거나 오타로 조용히 새 키가 생깁니다.
 */

import type { NaiMetadata } from './types';

export const STORAGE_KEYS = {
  /** 사용자 설정 (다운로드/안전장치/Discord/알림) */
  settings: 'naisu.settings',
  /** 배치 템플릿 슬롯 목록 + 활성 슬롯 */
  templates: 'naisu.templates',
  /** 구(舊) 단일 템플릿 — 마이그레이션 후 제거됨 */
  legacyTemplate: 'naisu.template',
  /** 생성 이력 */
  history: 'naisu.history',
  /** 자동 다운로드 약관 동의 상태 */
  disclaimer: 'naisu.disclaimer',
  /** 중단된 배치의 진행 커서 (이어서 실행용) */
  batchCursor: 'naisu.batchCursor',
  /** 최근 배치 실행 리포트 */
  reports: 'naisu.reports',
  /** 플로팅 패널 위치 */
  panelPos: 'naisu.panelPos',
} as const;

/** "설정 초기화"가 지워야 하는 키 — 이력·동의 기록은 건드리지 않습니다. */
export const SETTINGS_RESET_KEYS: string[] = [
  STORAGE_KEYS.settings,
  STORAGE_KEYS.templates,
  STORAGE_KEYS.legacyTemplate,
  STORAGE_KEYS.batchCursor,
];

/**
 * 하드클린 — 매직 바이트 탐지에 의존하지 않고 이미지를 캔버스로 다시 그려서 **JPEG로
 * 재인코딩**해 저장한다(.jpg). 컨테이너(webp RIFF)도, 알파 채널도, 픽셀 LSB도 원본에서
 * 아무것도 물려받지 않는 완전히 새 바이트 스트림이라 알파 LSB든 RGB LSB든 EXIF든
 * 알려지지 않은 은닉 방식이든 전부 제거된다. 대가: 투명도 소실 + JPEG 손실압축.
 * 클린 — 기존 방식(매직 바이트를 찾아서 alpha LSB만 소거, .webp 유지). 원본 — 아무것도 안 지움.
 * 둘 다 — 클린 파일 + 원본 파일을 함께 저장 (하드클린이 아니라 항상 클린 기준).
 */
export type DownloadMode = 'hardclean' | 'clean' | 'raw' | 'both';

export interface PromptPreset {
  id: string;
  text: string;
}

export type VariationMode = 'sequential' | 'random';

export interface BatchTemplate {
  /** 슬롯 식별자 — 이름은 사용자가 바꿀 수 있으므로 참조는 항상 id로 */
  id: string;
  /** 사용자 정의 이름 (예: template_02) */
  name: string;
  /** 모든 이미지에 공통으로 들어가는 프롬프트 */
  fixedPrompt: string;
  /** 프리셋을 실제로 사용할지 (off면 고정 프롬프트만 N장) */
  usePresets: boolean;
  /** 변경 부분 프리셋 목록 */
  presets: PromptPreset[];
  /** 차례대로 vs 무작위 */
  mode: VariationMode;
  /** 반복 횟수 (presets.length × repeats = 총 장수) */
  repeats: number;
  /** 매 장마다 시드 새로 뽑기 */
  randomSeed: boolean;
  /**
   * 네거티브(UC) 고정값. 빈 문자열이면 NAI 페이지의 현재 UC를 건드리지 않습니다.
   * 주입 배선은 별도 작업(N06) — 스키마만 먼저 자리를 잡아 둡니다.
   */
  uc: string;
  /**
   * 캐릭터 슬롯별 고정 프롬프트 (0~6개). 빈 배열이면 캐릭터 슬롯을 건드리지 않습니다.
   * 주입 배선은 별도 작업(N06).
   */
  characterPrompts: string[];
}

/** 템플릿 슬롯 저장 형태 — 여러 개를 두고 활성 슬롯 하나를 가리킵니다. */
export interface TemplateStore {
  templates: BatchTemplate[];
  activeId: string;
}

export interface DiscordSettings {
  url: string;
  events: {
    start: boolean;
    progress: boolean;
    item: boolean;
    pause: boolean;
    done: boolean;
    error: boolean;
  };
  /** progress 이벤트 주기 (몇 장마다) */
  progressEvery: number;
}

/** 브라우저 알림 — Discord를 설정하지 않은 사용자를 위한 기본 통보 수단 */
export interface NotificationSettings {
  done: boolean;
  error: boolean;
  anlasFloor: boolean;
}

/**
 * 플로팅 패널의 모양.
 * card — 기존 가로 카드(280px). 로그까지 항상 보인다.
 * rail — 세로 아이콘 레일(56px). 화면을 거의 가리지 않는 대신 글자 라벨이 없다.
 */
export type PanelLayout = 'card' | 'rail';

/** 패널 테마. system은 OS 다크 모드 설정을 따른다. */
export type PanelTheme = 'light' | 'dark' | 'system';

/** Anlas 하한에 닿았을 때: 배치를 끝낼지, 멈춰 두고 충전 후 재개할지 */
export type AnlasFloorAction = 'stop' | 'pause';

export interface Settings {
  downloadMode: DownloadMode;
  /** 다운로드 최상위 폴더 (Chrome downloads 경로 하위). 파일명 토큰 사용 가능 */
  downloadFolder: string;
  /**
   * 배치마다 만드는 하위 폴더 템플릿. 빈 문자열이면 하위 폴더 없이 최상위에 바로 저장.
   * 토큰: {batch}{date}{time}{datetime}{template}
   */
  batchFolderTemplate: string;
  /** 파일명 템플릿. 토큰: {seed}{model}{w}{h}{steps}{sampler}{date}{time}{datetime}{idx}{uuid}{batch}{template} */
  filenameTemplate: string;
  /** 최소 Anlas. 이 아래로 떨어지면 배치 중단 */
  anlasFloor: number;
  /** Anlas 하한에 닿았을 때의 동작 */
  onAnlasFloor: AnlasFloorAction;
  /** 각 생성 사이 대기 (ms) */
  cooldownMs: number;
  /** 재시도 횟수 */
  maxRetries: number;
  /** 한 장당 타임아웃 (ms) */
  timeoutMs: number;
  /** 색상 프로파일(ICCP) 보존 여부 — 기본 false (메타 다 제거) */
  keepColorProfile: boolean;
  /**
   * 배치 실행 중 시스템 절전을 막을지.
   * 'system' 수준이라 화면은 꺼져도 되고 시스템만 깨어 있게 한다 — 화면을 강제로 켜 두는
   * 것보다 덜 침습적이면서, 절전 때문에 탭이 멈춰 배치가 끊기는 것은 막는다.
   */
  keepAwake: boolean;
  /** 이력 보관 개수 상한 */
  historyLimit: number;
  /** 패널 장수 입력값 — 사용자가 직접 넣은 값은 템플릿 변경에도 유지 */
  panelCount: number;
  /** 플로팅 패널 모양 */
  panelLayout: PanelLayout;
  /** 플로팅 패널 테마 */
  panelTheme: PanelTheme;
  /** 브라우저 알림 */
  notifications: NotificationSettings;
  /** Discord 웹훅 */
  discord: DiscordSettings;
  /** 마지막으로 본 이미지 메타 (popup 표시용) */
  lastMeta?: NaiMetadata;
}

export const DEFAULTS: Settings = {
  downloadMode: 'clean',
  downloadFolder: 'naisu',
  batchFolderTemplate: '{batch}',
  filenameTemplate: '{datetime}_{seed}',
  anlasFloor: 100,
  onAnlasFloor: 'stop',
  cooldownMs: 1500,
  maxRetries: 3,
  timeoutMs: 60_000,
  keepColorProfile: false,
  keepAwake: true,
  historyLimit: 500,
  panelCount: 1,
  panelLayout: 'card',
  panelTheme: 'light',
  notifications: { done: true, error: true, anlasFloor: true },
  discord: {
    url: '',
    events: { start: true, progress: true, item: false, pause: true, done: true, error: true },
    progressEvery: 10,
  },
};

export async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const stored = (got[STORAGE_KEYS.settings] ?? {}) as Partial<Settings>;
  return {
    ...DEFAULTS,
    ...stored,
    notifications: { ...DEFAULTS.notifications, ...(stored.notifications ?? {}) },
    discord: {
      ...DEFAULTS.discord,
      ...(stored.discord ?? {}),
      events: {
        ...DEFAULTS.discord.events,
        ...(stored.discord?.events ?? {}),
      },
    },
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

// ---------------------------------------------------------------------------
// 배치 템플릿 슬롯
// ---------------------------------------------------------------------------

export function makeDefaultTemplate(name = 'template_01'): BatchTemplate {
  return {
    id: cryptoId(),
    name,
    fixedPrompt: '1girl, simple background, masterpiece, best quality, very aesthetic',
    usePresets: false,
    presets: [
      { id: cryptoId(), text: 'smile, standing, front view' },
      { id: cryptoId(), text: 'pout, sitting, 3/4 view' },
      { id: cryptoId(), text: '>_<, running at viewer, dynamic angle' },
    ],
    mode: 'sequential',
    repeats: 5,
    randomSeed: true,
    uc: '',
    characterPrompts: [],
  };
}

/** 부분 저장값을 항상 완전한 템플릿으로 채워서 돌려줍니다 (DEFAULTS 병합 규칙과 동일). */
function normalizeTemplate(raw: Partial<BatchTemplate> | undefined, fallbackName: string): BatchTemplate {
  const base = makeDefaultTemplate(fallbackName);
  if (!raw) return base;
  return {
    ...base,
    ...raw,
    id: raw.id ?? base.id,
    presets: Array.isArray(raw.presets) ? raw.presets : base.presets,
    uc: typeof raw.uc === 'string' ? raw.uc : '',
    characterPrompts: Array.isArray(raw.characterPrompts) ? raw.characterPrompts : [],
  };
}

/**
 * 템플릿 슬롯 전체를 읽습니다.
 *
 * 구버전(단일 `naisu.template`)만 있으면 첫 슬롯으로 이관하고 즉시 새 키에 씁니다.
 * 이관은 멱등이라 여러 컨텍스트가 동시에 실행해도 결과가 같습니다.
 */
export async function getTemplateStore(): Promise<TemplateStore> {
  const got = await chrome.storage.local.get([STORAGE_KEYS.templates, STORAGE_KEYS.legacyTemplate]);
  const stored = got[STORAGE_KEYS.templates] as Partial<TemplateStore> | undefined;

  if (stored && Array.isArray(stored.templates) && stored.templates.length > 0) {
    const templates = stored.templates.map((t, i) => normalizeTemplate(t, `template_${pad(i + 1)}`));
    const activeId = templates.some((t) => t.id === stored.activeId)
      ? stored.activeId!
      : templates[0]!.id;
    return { templates, activeId };
  }

  // 이관: 구 단일 템플릿 → 슬롯 1개짜리 스토어
  const legacy = got[STORAGE_KEYS.legacyTemplate] as Partial<BatchTemplate> | undefined;
  const first = normalizeTemplate(legacy, 'template_01');
  const store: TemplateStore = { templates: [first], activeId: first.id };
  await chrome.storage.local.set({ [STORAGE_KEYS.templates]: store });
  if (legacy) {
    await chrome.storage.local.remove(STORAGE_KEYS.legacyTemplate);
    console.log('[naisu] 템플릿 이관 완료 — naisu.template → naisu.templates[0]');
  }
  return store;
}

export async function setTemplateStore(store: TemplateStore): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.templates]: store });
}

/** 현재 활성 템플릿. 기존 호출부(runner/overlay/popup)는 계속 이 함수만 쓰면 됩니다. */
export async function getTemplate(): Promise<BatchTemplate> {
  const store = await getTemplateStore();
  return store.templates.find((t) => t.id === store.activeId) ?? store.templates[0]!;
}

/** 활성 템플릿을 덮어씁니다 (슬롯 위치 유지). */
export async function setTemplate(t: BatchTemplate): Promise<void> {
  const store = await getTemplateStore();
  const idx = store.templates.findIndex((x) => x.id === t.id);
  if (idx >= 0) store.templates[idx] = t;
  else store.templates.push(t);
  store.activeId = t.id;
  await setTemplateStore(store);
}

export async function setActiveTemplate(id: string): Promise<void> {
  const store = await getTemplateStore();
  if (!store.templates.some((t) => t.id === id)) return;
  await setTemplateStore({ ...store, activeId: id });
}

export async function getTemplateById(id: string): Promise<BatchTemplate | null> {
  const store = await getTemplateStore();
  return store.templates.find((t) => t.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// 자동 다운로드 약관 동의 (D01)
// ---------------------------------------------------------------------------

/**
 * 동의 문구가 바뀌면 이 숫자를 올립니다 — 저장된 버전이 낮으면 다시 동의를 받습니다.
 * (약관 인용문을 갱신했을 때 반드시 함께 올릴 것)
 */
export const DISCLAIMER_VERSION = 1;

export interface DisclaimerState {
  accepted: boolean;
  version: number;
  acceptedAt: number;
}

const DISCLAIMER_DEFAULT: DisclaimerState = { accepted: false, version: 0, acceptedAt: 0 };

export async function getDisclaimer(): Promise<DisclaimerState> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.disclaimer);
  return { ...DISCLAIMER_DEFAULT, ...((got[STORAGE_KEYS.disclaimer] ?? {}) as Partial<DisclaimerState>) };
}

/** 현재 버전 기준으로 동의가 유효한지. 문구가 개정되면 자동으로 false가 됩니다. */
export async function isDisclaimerAccepted(): Promise<boolean> {
  const s = await getDisclaimer();
  return s.accepted && s.version >= DISCLAIMER_VERSION;
}

export async function acceptDisclaimer(): Promise<void> {
  const state: DisclaimerState = {
    accepted: true,
    version: DISCLAIMER_VERSION,
    acceptedAt: Date.now(),
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.disclaimer]: state });
}

export async function revokeDisclaimer(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.disclaimer);
}

// ---------------------------------------------------------------------------
// 배치 진행 커서 (N07) / 실행 리포트 (U07)
// ---------------------------------------------------------------------------

export interface BatchCursor {
  batchId: string;
  templateId: string;
  /** 이 배치가 목표로 한 총 장수 */
  total: number;
  /** 다음에 시작할 인덱스 (0-based) */
  nextIdx: number;
  startedAt: number;
  /** 이어서 실행할 때 같은 폴더에 쌓기 위해 보관 */
  folder: string;
  /** 왜 멈췄는지 — 이어하기 안내 문구에 사용 */
  reason: 'user' | 'anlas' | 'error' | 'unload';
}

export async function getBatchCursor(): Promise<BatchCursor | null> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.batchCursor);
  return (got[STORAGE_KEYS.batchCursor] as BatchCursor | undefined) ?? null;
}

export async function setBatchCursor(cursor: BatchCursor): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.batchCursor]: cursor });
}

export async function clearBatchCursor(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.batchCursor);
}

export interface BatchFailure {
  idx: number;
  prompt: string;
  reason: string;
  /** stripStatus.detail 등 원인 추적용 상세 (있을 때만) */
  detail?: string;
}

export interface BatchReport {
  batchId: string;
  templateName: string;
  startedAt: number;
  finishedAt: number;
  /** 목표 장수 */
  total: number;
  /** 실제로 생성까지 성공한 장수 */
  done: number;
  /** 실제로 저장된 파일 개수 (그리드·둘 다 모드면 done보다 큼) */
  savedFiles: number;
  anlasUsed: number;
  stoppedBy: 'complete' | 'user' | 'anlas' | 'error';
  failures: BatchFailure[];
}

const MAX_REPORTS = 20;

export async function getReports(): Promise<BatchReport[]> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.reports);
  return (got[STORAGE_KEYS.reports] as BatchReport[] | undefined) ?? [];
}

export async function addReport(report: BatchReport): Promise<void> {
  const list = await getReports();
  list.unshift(report);
  if (list.length > MAX_REPORTS) list.splice(MAX_REPORTS);
  await chrome.storage.local.set({ [STORAGE_KEYS.reports]: list });
}

export async function clearReports(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.reports);
}

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------

export function cryptoId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export interface FilenameContext {
  seed?: number;
  model?: string;
  w?: number;
  h?: number;
  steps?: number;
  sampler?: string;
  batch?: string;
  template?: string;
  idx?: number;
}

/** 파일명 템플릿에서 쓸 수 있는 토큰 목록 — 팝업 칩과 문서가 이 배열 하나를 참조합니다. */
export const FILENAME_TOKENS = [
  '{seed}', '{model}', '{sampler}', '{w}', '{h}', '{steps}',
  '{date}', '{time}', '{datetime}', '{idx}', '{uuid}', '{batch}', '{template}',
] as const;

/** 폴더 템플릿에서 의미가 있는 토큰만 추린 것 (이미지별로 달라지는 값은 폴더에 부적합). */
export const FOLDER_TOKENS = ['{batch}', '{date}', '{time}', '{datetime}', '{template}'] as const;

/**
 * 파일명/폴더 템플릿에서 토큰을 치환합니다.
 * 알 수 없는 토큰은 빈 문자열로 지워집니다 (미리보기에서 바로 드러남).
 */
export function renderFilename(template: string, ctx: FilenameContext): string {
  const now = new Date();
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');
  const tokens: Record<string, string> = {
    seed: ctx.seed?.toString() ?? 'noseed',
    model: safe(ctx.model ?? 'nai'),
    w: ctx.w?.toString() ?? '?',
    h: ctx.h?.toString() ?? '?',
    steps: ctx.steps?.toString() ?? '?',
    sampler: safe(ctx.sampler ?? ''),
    date,
    time,
    datetime: `${date}_${time}`,
    idx: ctx.idx !== undefined ? pad(ctx.idx, 3) : '',
    batch: safe(ctx.batch ?? ''),
    template: safe(ctx.template ?? ''),
    uuid: crypto.randomUUID().slice(0, 8),
  };
  return template.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? '');
}

/**
 * 다운로드 경로(폴더 부분)를 만듭니다.
 * 빈 세그먼트는 버려지므로 batchFolderTemplate이 비어 있으면 최상위 폴더만 남습니다.
 */
export function renderFolder(
  settings: Pick<Settings, 'downloadFolder' | 'batchFolderTemplate'>,
  ctx: FilenameContext,
): string {
  return [settings.downloadFolder, settings.batchFolderTemplate]
    .map((part) => renderFilename(part, ctx))
    .flatMap((part) => part.split('/'))
    .map((seg) => seg.trim())
    .filter(Boolean)
    .join('/');
}
