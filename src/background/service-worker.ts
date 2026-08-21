/**
 * MV3 service worker.
 * - content script로부터 다운로드 요청을 받아 chrome.downloads로 위임
 * - Discord 웹훅 호출 (CORS 회피)
 *
 * 주의: MV3 SW에는 URL.createObjectURL이 없습니다 (Chrome 일부 버전).
 * 따라서 data: URL로 다운로드합니다.
 */

import { stripMetadata, parseWebP } from '../lib/webp-riff';
import type { DownloadMode } from '../lib/storage';

interface DownloadReq {
  type: 'naisu.download';
  payload: {
    bytes: string; // base64
    mode: DownloadMode;
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
 * strip 함수들이 "무슨 일이 있었는지"를 조용히 삼키지 않고 호출자에게 그대로 보고하기 위한 결과 타입.
 * (2026-08-21 조사: PC별로 하드클린이 되거나 안 되는 보고의 유력 원인이 catch{}에서 원본을 조용히
 *  반환해버리는 것이었음 — 아래부터는 항상 status/error를 리턴해서 UI/로그에서 확인 가능하게 한다.)
 */
type StripStatus = 'ok' | 'not-webp' | 'no-magic' | 'error';

interface StripResult {
  data: Uint8Array;
  status: StripStatus;
  error?: string;
  /**
   * 콘솔에만 남기는 상세 진단(바이트 덤프, 환경 정보 등). 배너/패널에 보여주는 `error`
   * 메시지는 사람이 읽을 요약으로 짧게 유지하고, 원인 추적에 필요한 잡다한 정보는
   * 전부 여기로 몰아서 content script가 콘솔에 그대로 찍게 한다.
   */
  detail?: string;
}

/** OffscreenCanvas/createImageBitmap 지원 여부 + UA — 재인코딩 실패가 환경 문제인지 구분하는 데 필요 */
function envFingerprint(): string {
  return `OffscreenCanvas=${typeof OffscreenCanvas !== 'undefined'} createImageBitmap=${typeof createImageBitmap !== 'undefined'} convertToBlob=${typeof OffscreenCanvas !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype} UA="${navigator.userAgent}"`;
}

/**
 * "WebP로 인식 안 됨" 실패는 예외가 아니라 조용한 early-return이라 콘솔에 아무 흔적도
 * 안 남았다(2026-08-21 재보고로 발견 — 배너는 뜨는데 콘솔은 비어있어서 원인 추적이
 * 안 됐음). 다음에 또 나오면 이 로그로 바로 원인 후보를 좁힐 수 있게 바이트 앞부분을
 * 같이 남긴다 — 예: 전부 0이면 fetch가 빈 blob을 받아온 것(blob URL revoke 레이스
 * 의심), RIFF는 맞는데 WEBP가 아니면 실제로 다른 컨테이너 포맷일 가능성.
 */
function describeNotWebp(bytes: Uint8Array): string {
  const head = Array.from(bytes.subarray(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  const magic = new TextDecoder('latin1').decode(bytes.subarray(0, 4));
  return `length=${bytes.length}B, first4="${magic}", first16Bytes=[${head}]`;
}

/** Error 객체에서 최대한 뽑아낼 수 있는 정보를 다 모은다(name/message/stack, 아니면 String()). */
function describeError(e: unknown): string {
  if (e instanceof Error) {
    return `${e.name}: ${e.message}${e.stack ? `\nstack: ${e.stack}` : ''}`;
  }
  return String(e);
}

/**
 * stealth_pngcomp 메타데이터 제거 — NAI V4.5+는 alpha LSB에 column-major 방식으로
 * 프롬프트 JSON을 숨깁니다. OffscreenCanvas로 alpha LSB를 0으로 만든 뒤 재인코딩.
 */
async function stripStealthAlpha(bytes: Uint8Array): Promise<StripResult> {
  if (!parseWebP(bytes).isWebP) {
    const detail = describeNotWebp(bytes);
    console.warn('[naisu] stripStealthAlpha: WebP로 인식되지 않음 —', detail);
    return { data: bytes, status: 'not-webp', detail };
  }
  let stage = 'createImageBitmap';
  try {
    console.log(`[naisu] stripStealthAlpha 시작: 입력 ${bytes.length}B`);
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/webp' }));
    const { width, height } = bitmap;
    console.log(`[naisu] stripStealthAlpha: ${stage} 완료 — ${width}x${height}`);

    stage = 'drawImage/getImageData';
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const id = ctx.getImageData(0, 0, width, height);
    const data = id.data;

    stage = 'magic-scan';
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
    if (!found) {
      console.log('[naisu] stripStealthAlpha: 매직 미검출 — no-magic으로 스킵');
      return { data: bytes, status: 'no-magic' };
    }
    console.log('[naisu] stripStealthAlpha: 매직 검출됨, alpha LSB 소거 진행');

    stage = 'lsb-clear/putImageData';
    // 모든 alpha LSB 소거
    for (let i = 3; i < data.length; i += 4) data[i] &= 0xfe;
    ctx.putImageData(id, 0, 0);

    stage = 'convertToBlob';
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 1.0 });
    const out = new Uint8Array(await blob.arrayBuffer());
    console.log(`[naisu] stripStealthAlpha 완료: 출력 ${out.length}B (blob.type=${blob.type})`);
    return { data: out, status: 'ok' };
  } catch (e) {
    const detail = `실패 단계=${stage} | ${describeError(e)} | env: ${envFingerprint()} | 입력 ${bytes.length}B`;
    console.error('[naisu] stripStealthAlpha 실패 — 원본을 그대로 반환합니다.', detail, e);
    return { data: bytes, status: 'error', error: e instanceof Error ? e.message : String(e), detail };
  }
}

/**
 * 하드클린 — stripStealthAlpha는 stealth_pngcomp 매직 바이트를 먼저 찾은 뒤에만 지우기
 * 때문에, 그 탐지 자체가 실패하면(디코드 경로에 따라 alpha LSB가 미묘하게 달라질 수 있음 —
 * 예: OS/GPU별 캔버스 프리멀티플라이 알파 반올림 차이) 조용히 원본을 그대로 반환해버린다.
 * 게다가 알려지지 않은 방식으로 RGB 채널에 숨긴 데이터는 애초에 손도 안 댄다.
 *
 * 하드클린은 그런 탐지에 전혀 의존하지 않는다. 이미지를 캔버스로 다시 그려서 **JPEG로
 * 재인코딩**한다 — WebP 무손실 재인코딩이 아니라 JPEG를 고른 이유:
 *  1) JPEG는 컨테이너 규격 자체에 alpha 채널이 없다. "alpha를 255로 민다"는 코드로
 *     흉내낼 필요 없이, 흰 배경에 합성하는 순간 alpha 채널은 물리적으로 사라진다.
 *  2) JPEG는 8×8 DCT + 양자화를 거치는 손실 압축이라(크로마 서브샘플링까지 겹침),
 *     RGB 채널 LSB에 뭘 숨겼든 픽셀 값 자체가 뭉개진다 — WebP quality:1.0(브라우저
 *     구현별로 무손실 여부가 보장되지 않음, report_0821.md 참고)보다 "픽셀 그대로
 *     살아남을 여지"가 구조적으로 훨씬 적다.
 *  3) 캔버스에서 만든 JPEG blob은 원본의 EXIF를 아예 물려받지 않는다(새로 만든
 *     바이트 스트림이라 애초에 EXIF 세그먼트가 없음).
 * 즉 "포맷을 통째로 바꿔서 원본 컨테이너·픽셀 데이터를 아예 안 물려받는다"는 하드클린의
 * 기존 설계를 더 강하게 밀어붙인 것. 대가는 그대로: 투명도(알파)는 사라지고, 손실
 * 압축이라 화질이 원본보다 살짝 떨어진다.
 */
const HARDCLEAN_JPEG_QUALITY = 0.92;

async function hardCleanReencode(bytes: Uint8Array): Promise<StripResult> {
  if (!parseWebP(bytes).isWebP) {
    const detail = describeNotWebp(bytes);
    console.warn('[naisu] hardCleanReencode: WebP로 인식되지 않음 —', detail);
    return { data: bytes, status: 'not-webp', detail };
  }
  let stage = 'createImageBitmap';
  try {
    console.log(`[naisu] hardCleanReencode 시작: 입력 ${bytes.length}B`);
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/webp' }));
    const { width, height } = bitmap;
    console.log(`[naisu] hardCleanReencode: ${stage} 완료 — ${width}x${height}`);

    stage = 'drawImage';
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    // JPEG는 alpha가 없으므로 흰 배경에 합성 — 투명 영역이 검게 뭉개지는 걸 방지
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    stage = 'convertToBlob(jpeg)';
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: HARDCLEAN_JPEG_QUALITY });
    const out = new Uint8Array(await blob.arrayBuffer());
    console.log(`[naisu] hardCleanReencode 완료: 출력 ${out.length}B (blob.type=${blob.type})`);
    return { data: out, status: 'ok' };
  } catch (e) {
    const detail = `실패 단계=${stage} | ${describeError(e)} | env: ${envFingerprint()} | 입력 ${bytes.length}B`;
    console.error('[naisu] hardCleanReencode 실패 — 원본을 그대로 반환합니다.', detail, e);
    return { data: bytes, status: 'error', error: e instanceof Error ? e.message : String(e), detail };
  }
}

interface StripStatusReport {
  mode: DownloadMode;
  level: 'good' | 'info' | 'bad';
  message: string;
  /** 배너/로그에는 안 보이는 상세 진단 — content script가 콘솔에만 찍는다. */
  detail?: string;
}

/** StripResult → 사용자에게 보여줄 한 줄 메시지 + 로그 심각도(+ 콘솔 전용 상세). */
function describeStripStatus(mode: DownloadMode, hadExifBefore: boolean, result: StripResult): StripStatusReport {
  const label = mode === 'hardclean' ? '하드클린' : '클린';
  switch (result.status) {
    case 'ok':
      return {
        mode,
        level: 'good',
        message:
          mode === 'hardclean'
            ? '하드클린 완료 — JPEG로 완전 재인코딩됨(EXIF 없음, 알파채널 자체가 없어 은닉 채널도 함께 사라짐)'
            : `클린 완료 — 컨테이너 메타데이터${hadExifBefore ? ' 제거' : ' 없음'} + 알파채널 은닉 데이터 제거됨`,
      };
    case 'no-magic':
      // clean/both 전용 경로(하드클린은 매직 탐지를 아예 안 함) — 은닉 데이터가 애초에 없었을 수도,
      // 디코드 환경 차이로 탐지를 놓쳤을 수도 있어 성공/실패를 단정하지 않고 정보성으로만 알림.
      return {
        mode,
        level: 'info',
        message: `클린 완료 — 컨테이너 메타데이터${hadExifBefore ? ' 제거' : ' 없음'}, 알파채널 은닉 데이터는 검출 안 됨(원래 없었거나 탐지를 놓쳤을 수 있음 — 확실히 지우려면 하드클린 사용)`,
      };
    case 'not-webp':
      return {
        mode,
        level: 'bad',
        message: `⚠ ${label} 실패 — WebP로 인식되지 않아 메타데이터를 전혀 제거하지 못했습니다. 원본이 그대로 저장되었습니다.`,
        detail: result.detail,
      };
    case 'error':
      return {
        mode,
        level: 'bad',
        message: `✕ ${label} 실패 — 재인코딩 중 오류: ${result.error ?? '알 수 없는 오류'}. 원본이 그대로 저장되었습니다.`,
        detail: result.detail,
      };
  }
}

interface DownloadResult {
  saved: string[];
  errors?: string[];
  /** 클린/하드클린 스트리핑이 실제로 어떻게 됐는지 — content script가 UI 로그·알림에 그대로 사용 */
  stripStatus?: StripStatusReport;
}

async function handleDownload(req: DownloadReq): Promise<DownloadResult> {
  const { bytes, mode, folder, filename, strip } = req.payload;
  const raw = b64ToBytes(bytes);
  console.log(
    `[naisu] handleDownload 시작: mode=${mode} filename="${filename}" folder="${folder}" keepIccp=${strip.keepIccp} base64Length=${bytes.length} rawBytesLength=${raw.length}`,
  );

  // mode 별로 저장할 (data, suffix, 확장자/MIME) 작업 목록
  const MIME_BY_EXT = { webp: 'image/webp', jpg: 'image/jpeg' } as const;
  const tasks: Array<{ data: Uint8Array; suffix: string; ext: keyof typeof MIME_BY_EXT }> = [];
  let stripStatus: DownloadResult['stripStatus'];
  if (mode === 'hardclean' || mode === 'clean' || mode === 'both') {
    const rawInfo = parseWebP(raw);
    console.log(
      `[naisu] handleDownload: raw 청크=[${rawInfo.chunks.map((c) => c.fourcc).join(',')}] truncated=${rawInfo.truncated} vp8xFlags=${rawInfo.vp8xFlags?.toString(16) ?? 'n/a'}`,
    );
    const riffCleaned = stripMetadata(raw, strip);
    // '둘 다'는 하드클린이 아니라 항상 (기존)클린 + 원본 조합
    const result =
      mode === 'hardclean' ? await hardCleanReencode(riffCleaned) : await stripStealthAlpha(riffCleaned);
    // 재인코딩이 실제로 성공했을 때만 jpg — not-webp/error로 폴백해 원본 webp 바이트를
    // 그대로 반환한 경우까지 .jpg로 저장하면 확장자와 실제 내용이 어긋난다.
    const ext = mode === 'hardclean' && result.status === 'ok' ? 'jpg' : 'webp';
    tasks.push({ data: result.data, suffix: '', ext });   // 클린류가 기본(접미사 없음)
    stripStatus = rawInfo.truncated
      ? {
          mode,
          level: 'bad',
          message: `⚠ WebP 컨테이너 파싱이 중간에 손상/절단되어 EXIF 등 일부 청크를 확인하지 못했습니다 — 메타데이터가 남아있을 수 있습니다. (콘솔 로그 참고)`,
          detail: `raw 청크=[${rawInfo.chunks.map((c) => c.fourcc).join(',')}] rawBytesLength=${raw.length}`,
        }
      : describeStripStatus(mode, !!rawInfo.getChunk('EXIF'), result);
    if (stripStatus.detail) console.warn('[naisu] handleDownload: stripStatus detail —', stripStatus.detail);
  }
  if (mode === 'raw' || mode === 'both') {
    tasks.push({ data: raw, suffix: mode === 'both' ? '_raw' : '', ext: 'webp' }); // both면 _raw 접미사
  }

  const saved: string[] = [];
  const errors: string[] = [];
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '');
  const safeFolder = folder.split('/').map(safe).filter(Boolean).join('/');
  const safeName = safe(filename || `image_${Date.now()}`);

  for (const t of tasks) {
    const path = `${safeFolder}/${safeName}${t.suffix}.${t.ext}`;
    try {
      // SW에서 안전: data: URL 사용 (URL.createObjectURL 미지원 환경 대응)
      const url = `data:${MIME_BY_EXT[t.ext]};base64,${bytesToB64(t.data)}`;
      const id = await chrome.downloads.download({
        url,
        filename: path,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      if (typeof id === 'number') {
        saved.push(path);
      } else {
        console.warn(`[naisu] handleDownload: chrome.downloads.download 거부됨 — ${path}`);
        errors.push(`다운로드 거부: ${path}`);
      }
    } catch (e) {
      console.error(`[naisu] handleDownload: chrome.downloads.download 예외 — ${path}`, describeError(e));
      errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`[naisu] handleDownload 종료: saved=${JSON.stringify(saved)} errors=${JSON.stringify(errors)}`);
  return errors.length ? { saved, errors, stripStatus } : { saved, stripStatus };
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

console.log(`[naisu] service worker booted — ${envFingerprint()}`);
