export interface HistoryEntry {
  id: string;
  savedAt: number;
  /** 배경/씬 프롬프트 */
  prompt: string;
  /** 캐릭터 슬롯 프롬프트 (0~6개) */
  characters?: string[];
  uc?: string;
  seed?: number;
  model?: string;
  sampler?: string;
  width?: number;
  height?: number;
  steps?: number;
  scale?: number;
}

import { getSettings, STORAGE_KEYS } from './storage';

const KEY = STORAGE_KEYS.history;

export async function getHistory(): Promise<HistoryEntry[]> {
  const got = await chrome.storage.local.get(KEY);
  return (got[KEY] as HistoryEntry[] | undefined) ?? [];
}

export async function addHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'savedAt'>): Promise<void> {
  const [list, settings] = await Promise.all([getHistory(), getSettings()]);
  list.unshift({ ...entry, id: crypto.randomUUID().slice(0, 8), savedAt: Date.now() });
  const limit = Math.max(1, settings.historyLimit);
  if (list.length > limit) list.splice(limit);
  await chrome.storage.local.set({ [KEY]: list });
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const list = await getHistory();
  await chrome.storage.local.set({ [KEY]: list.filter((e) => e.id !== id) });
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

/**
 * 저장 개수 상한을 지금 즉시 적용합니다 (P05 — 사용자가 설정 화면에서 상한을 줄였을 때
 * 초과분을 바로 정리하는 용도). addHistoryEntry()는 새 항목이 들어올 때만 자르므로,
 * 상한만 낮추고 새로 생성하지 않으면 기존 초과분이 그대로 남아 있는 문제를 해결한다.
 * 반환값은 실제로 잘려나간 개수.
 */
export async function pruneHistoryToLimit(limit: number): Promise<number> {
  const list = await getHistory();
  const max = Math.max(1, limit);
  if (list.length <= max) return 0;
  const removed = list.length - max;
  await chrome.storage.local.set({ [KEY]: list.slice(0, max) });
  return removed;
}
