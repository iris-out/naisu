/**
 * MV3 service worker.
 * - content script로부터 다운로드 요청을 받아 chrome.downloads로 위임
 * - Discord 웹훅 호출 (CORS 회피)
 *
 * 주의: MV3 SW에는 URL.createObjectURL이 없습니다 (Chrome 일부 버전).
 * 따라서 data: URL로 다운로드합니다.
 */

import { stripMetadata, parseWebP } from '../lib/webp-riff';

interface DownloadReq {
  type: 'naisu.download';
  payload: {
    bytes: string; // base64
    mode: 'clean' | 'raw' | 'both';
    folder: string;
    filename: string;
    strip: { keepIccp: boolean };
  };
}

interface WebhookReq {
  type: 'naisu.webhook';
  payload: {
    url: string;
    body: unknown;
  };
}

interface BadgeReq {
  type: 'naisu.badge';
  payload: { text: string; color?: string };
}

type Req = DownloadReq | WebhookReq | BadgeReq;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

/**
 * stealth_pngcomp 메타데이터 제거 — NAI V4.5는 alpha LSB에 column-major 방식으로
 * 프롬프트 JSON을 숨깁니다. OffscreenCanvas로 alpha LSB를 0으로 만든 뒤 재인코딩.
 */
async function stripStealthAlpha(bytes: Uint8Array): Promise<Uint8Array> {
  if (!parseWebP(bytes).isWebP) return bytes;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/webp' }));
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const id = ctx.getImageData(0, 0, width, height);
    const data = id.data;

    // "stealth_pngcomp" 매직 확인 (column-major, alpha LSB)
    // 비트 n → row = n % height, col = floor(n / height)
    let bitIdx = 0;
    const readByte = (): number => {
      let b = 0;
      for (let i = 0; i < 8; i++) {
        const row = bitIdx % height;
        const col = Math.floor(bitIdx / height);
        b |= (data[(row * width + col) * 4 + 3] & 1) << (7 - i);
        bitIdx++;
      }
      return b;
    };

    const MAGIC = 'stealth_pngcomp';
    let found = true;
    for (let i = 0; i < MAGIC.length; i++) {
      if (readByte() !== MAGIC.charCodeAt(i)) { found = false; break; }
    }
    if (!found) return bytes;

    // 모든 alpha LSB 소거
    for (let i = 3; i < data.length; i += 4) data[i] &= 0xfe;
    ctx.putImageData(id, 0, 0);

    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 1.0 });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return bytes;
  }
}

async function handleDownload(req: DownloadReq): Promise<{ saved: string[]; errors?: string[] }> {
  const { bytes, mode, folder, filename, strip } = req.payload;
  const raw = b64ToBytes(bytes);

  // mode 별로 저장할 (data, suffix) 작업 목록
  const tasks: Array<{ data: Uint8Array; suffix: string }> = [];
  if (mode === 'clean' || mode === 'both') {
    const riffCleaned = stripMetadata(raw, strip);
    const cleaned = await stripStealthAlpha(riffCleaned);
    tasks.push({ data: cleaned, suffix: '' });          // 클린이 기본(접미사 없음)
  }
  if (mode === 'raw' || mode === 'both') {
    tasks.push({ data: raw, suffix: mode === 'both' ? '_raw' : '' }); // both면 _raw 접미사
  }

  const saved: string[] = [];
  const errors: string[] = [];
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '');
  const safeFolder = folder.split('/').map(safe).filter(Boolean).join('/');
  const safeName = safe(filename || `image_${Date.now()}`);

  for (const t of tasks) {
    const path = `${safeFolder}/${safeName}${t.suffix}.webp`;
    try {
      // SW에서 안전: data: URL 사용 (URL.createObjectURL 미지원 환경 대응)
      const url = `data:image/webp;base64,${bytesToB64(t.data)}`;
      const id = await chrome.downloads.download({
        url,
        filename: path,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      if (typeof id === 'number') saved.push(path);
      else errors.push(`다운로드 거부: ${path}`);
    } catch (e) {
      errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return errors.length ? { saved, errors } : { saved };
}

async function handleWebhook(req: WebhookReq): Promise<{ ok: boolean; status?: number }> {
  try {
    const r = await fetch(req.payload.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.payload.body),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    console.warn('[naisu] webhook failed', e);
    return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((req: Req, _sender, sendResponse) => {
  (async () => {
    try {
      if (req.type === 'naisu.download') {
        sendResponse(await handleDownload(req));
      } else if (req.type === 'naisu.webhook') {
        sendResponse(await handleWebhook(req));
      } else if (req.type === 'naisu.badge') {
        chrome.action.setBadgeText({ text: req.payload.text });
        if (req.payload.color) {
          chrome.action.setBadgeBackgroundColor({ color: req.payload.color });
        }
        sendResponse({ ok: true });
      } else {
        sendResponse({ error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ error: String(e) });
    }
  })();
  return true; // async
});

console.log('[naisu] service worker booted');
