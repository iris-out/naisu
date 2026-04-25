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

const KEY = 'naisu.history';
const MAX = 500;

export async function getHistory(): Promise<HistoryEntry[]> {
  const got = await chrome.storage.local.get(KEY);
  return (got[KEY] as HistoryEntry[] | undefined) ?? [];
}

export async function addHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'savedAt'>): Promise<void> {
  const list = await getHistory();
  list.unshift({ ...entry, id: crypto.randomUUID().slice(0, 8), savedAt: Date.now() });
  if (list.length > MAX) list.splice(MAX);
  await chrome.storage.local.set({ [KEY]: list });
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const list = await getHistory();
  await chrome.storage.local.set({ [KEY]: list.filter((e) => e.id !== id) });
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
