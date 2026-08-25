/**
 * 원본 바이트 캐시 (IndexedDB, LRU).
 *
 * "다시 저장"이 성립하려면 **스트리핑 전 원본 바이트**를 들고 있어야 한다.
 * 하드클린이 조용히 실패했을 때(2026-08-21 조사 참고) 지금은 되돌릴 방법이 아예 없다 —
 * NAI 페이지의 blob URL은 곧 revoke되고, 저장된 파일은 이미 망가진 상태다.
 * 이 캐시가 그 유일한 복구 경로다.
 *
 * ⚠ 실행 컨텍스트: content script (novelai.net 오리진).
 *   원본 blob을 실제로 손에 쥐는 곳이 여기뿐이라 캐시도 여기 둔다. service worker에
 *   두려면 base64로 한 번 더 옮겨야 해서 메모리를 두 배로 쓴다.
 *
 * ⚠ 저장 용량: 이미지 한 장이 1~3MB다. 상한(Settings.cacheLimit)은 장수 기준이며,
 *   넘으면 오래된 것부터 지운다. 0이면 아무것도 저장하지 않는다(= 다시 저장 불가).
 */

const DB_NAME = 'naisu-images';
const DB_VERSION = 1;
const STORE = 'img';

export interface CachedImage {
  id: string;
  /** 스트리핑 전 원본 바이트 */
  bytes: ArrayBuffer;
  /** 확장자를 뺀, 저장 당시 사용한 파일명 */
  filename: string;
  seed?: number;
  model?: string;
  prompt?: string;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 열기 실패'));
  });
  // 실패한 Promise를 캐시해 두면 이후 모든 호출이 같은 오류로 죽는다 — 다음 호출에서 다시 시도하게 비운다.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 요청 실패'));
      }),
  );
}

/**
 * 원본 바이트를 캐시에 넣고 상한을 넘으면 오래된 것부터 지운다.
 * 실패해도 저장 흐름을 막지 않는다 — 캐시는 편의 기능이지 저장의 전제가 아니다.
 */
export async function cacheImage(entry: Omit<CachedImage, 'savedAt'>, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  try {
    await tx('readwrite', (s) => s.put({ ...entry, savedAt: Date.now() } satisfies CachedImage));
    await trimCache(limit);
    return true;
  } catch (e) {
    console.warn('[naisu] 원본 캐시 저장 실패 — 다시 저장은 이 이미지에 대해 불가능합니다', e);
    return false;
  }
}

export async function getCachedImage(id: string): Promise<CachedImage | null> {
  try {
    const got = await tx<CachedImage | undefined>('readonly', (s) => s.get(id));
    return got ?? null;
  } catch (e) {
    console.warn('[naisu] 원본 캐시 조회 실패', e);
    return null;
  }
}

/** 오래된 것부터 지워 상한(장수)에 맞춘다. */
export async function trimCache(limit: number): Promise<void> {
  try {
    const keys = await tx<IDBValidKey[]>('readonly', (s) => s.index('savedAt').getAllKeys());
    const excess = keys.length - Math.max(0, limit);
    if (excess <= 0) return;
    const db = await openDb();
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    // getAllKeys는 savedAt 오름차순이라 앞에서부터가 가장 오래된 것
    for (let i = 0; i < excess; i++) store.delete(keys[i]!);
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    console.log(`[naisu] 원본 캐시 정리 — ${excess}장 제거 (상한 ${limit}장)`);
  } catch (e) {
    console.warn('[naisu] 원본 캐시 정리 실패', e);
  }
}

export async function clearImageCache(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.clear());
  } catch (e) {
    console.warn('[naisu] 원본 캐시 비우기 실패', e);
  }
}

/** 팝업/패널에서 "지금 몇 장 들고 있는지" 보여주기 위한 값. */
export async function cacheCount(): Promise<number> {
  try {
    return await tx<number>('readonly', (s) => s.count());
  } catch {
    return 0;
  }
}
