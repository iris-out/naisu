/**
 * chrome.storage.local 얇은 래퍼.
 * 키마다 기본값을 알고 있어서 처음 호출 시에도 안전하게 값을 돌려줍니다.
 */

import type { NaiMetadata } from './types';

export type DownloadMode = 'clean' | 'raw' | 'both';

export interface PromptPreset {
  id: string;
  text: string;
}

export type VariationMode = 'sequential' | 'random';

export interface BatchTemplate {
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

export interface Settings {
  downloadMode: DownloadMode;
  /** 다운로드 폴더 (Chrome downloads 경로 하위) */
  downloadFolder: string;
  /** 파일명 템플릿. 토큰: {seed}{model}{w}{h}{steps}{datetime}{date}{time}{idx}{uuid}{batch} */
  filenameTemplate: string;
  /** 최소 Anlas. 이 아래로 떨어지면 배치 중단 */
  anlasFloor: number;
  /** 각 생성 사이 대기 (ms) */
  cooldownMs: number;
  /** 재시도 횟수 */
  maxRetries: number;
  /** 한 장당 타임아웃 (ms) */
  timeoutMs: number;
  /** 색상 프로파일(ICCP) 보존 여부 — 기본 false (메타 다 제거) */
  keepColorProfile: boolean;
  /** Discord 웹훅 */
  discord: DiscordSettings;
  /** 마지막으로 본 이미지 메타 (popup 표시용) */
  lastMeta?: NaiMetadata;
}

export const DEFAULTS: Settings = {
  downloadMode: 'clean',
  downloadFolder: 'naisu',
  filenameTemplate: '{datetime}_{seed}',
  anlasFloor: 100,
  cooldownMs: 1500,
  maxRetries: 3,
  timeoutMs: 60_000,
  keepColorProfile: false,
  discord: {
    url: '',
    events: { start: true, progress: true, item: false, pause: true, done: true, error: true },
    progressEvery: 10,
  },
};

const KEY = 'naisu.settings';

export async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(KEY);
  const stored = (got[KEY] ?? {}) as Partial<Settings>;
  return {
    ...DEFAULTS,
    ...stored,
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
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

const TEMPLATE_KEY = 'naisu.template';

export async function getTemplate(): Promise<BatchTemplate> {
  const got = await chrome.storage.local.get(TEMPLATE_KEY);
  return (
    {
      name: 'template_01',
      fixedPrompt:
        '1girl, simple background, masterpiece, best quality, very aesthetic',
      usePresets: false,
      presets: [
        { id: cryptoId(), text: 'smile, standing, front view' },
        { id: cryptoId(), text: 'pout, sitting, 3/4 view' },
        { id: cryptoId(), text: '>_<, running at viewer, dynamic angle' },
      ],
      mode: 'sequential',
      repeats: 5,
      randomSeed: true,
      ...((got[TEMPLATE_KEY] as Partial<BatchTemplate> | undefined) ?? {}),
    }
  );
}

export async function setTemplate(t: BatchTemplate): Promise<void> {
  await chrome.storage.local.set({ [TEMPLATE_KEY]: t });
}

export function cryptoId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * 파일명 템플릿에서 토큰을 치환합니다.
 */
export function renderFilename(
  template: string,
  ctx: {
    seed?: number;
    model?: string;
    w?: number;
    h?: number;
    steps?: number;
    sampler?: string;
    batch?: string;
    idx?: number;
  },
): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const tokens: Record<string, string> = {
    seed: ctx.seed?.toString() ?? 'noseed',
    model: (ctx.model ?? 'nai').replace(/[^A-Za-z0-9_.-]/g, '_'),
    w: ctx.w?.toString() ?? '?',
    h: ctx.h?.toString() ?? '?',
    steps: ctx.steps?.toString() ?? '?',
    sampler: (ctx.sampler ?? '').replace(/[^A-Za-z0-9_.-]/g, '_'),
    date,
    time,
    datetime: `${date}_${time}`,
    idx: ctx.idx !== undefined ? pad(ctx.idx, 3) : '',
    batch: (ctx.batch ?? '').replace(/[^A-Za-z0-9_.-]/g, '_'),
    uuid: crypto.randomUUID().slice(0, 8),
  };
  return template.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? '');
}
