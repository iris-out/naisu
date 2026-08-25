/**
 * MV3 service worker.
 * - content script로부터 다운로드 요청을 받아 chrome.downloads로 위임
 * - Discord 웹훅 호출 (CORS 회피)
 *
 * 주의: MV3 SW에는 URL.createObjectURL이 없습니다 (Chrome 일부 버전).
 * 따라서 data: URL로 다운로드합니다.
 */

import { stripMetadata, parseWebP } from '../lib/webp-riff';
import { DEFAULT_IMAGE_OPS, getSettings, isImageOpsIdentity, mergeImageOps } from '../lib/storage';
import type { ConflictAction, DownloadMode, ImageOps } from '../lib/storage';
import { encodeImage, opsSummary, renderProcessed } from '../lib/image-ops';
import { loadWatermarkFont } from '../lib/webfont';
import { writeCredit } from '../lib/metadata-write';
import { sendToTab } from '../lib/messages';
import type {
  DownloadPayload,
  DownloadResponse,
  ManifestPayload,
  NaisuMessage,
  NotifyPayload,
  OkResponse,
  SavedItem,
  ShowFilePayload,
  StripFilesPayload,
  StripFilesResponse,
  StripStatusReport,
  WebhookPayload,
  WebhookResponse,
} from '../lib/messages';

/** 메시지 타입은 lib/messages.ts에 단일 정의 — 여기서는 페이로드만 꺼내 쓴다. */
interface DownloadReq {
  type: 'naisu.download';
  payload: DownloadPayload;
}

interface WebhookReq {
  type: 'naisu.webhook';
  payload: WebhookPayload;
}

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
  // catch에서도 참조할 수 있게 try 밖에 선언 — 어느 단계까지 진행됐었는지 실패 로그에 남기기 위함(0=아직 못 얻음)
  let width = 0;
  let height = 0;
  try {
    console.log(`[naisu] stripStealthAlpha 시작: 입력 ${bytes.length}B`);
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/webp' }));
    ({ width, height } = bitmap);
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
    const detail = [
      `실패 단계=${stage}`,
      `이미지 크기=${width > 0 ? `${width}x${height}` : 'n/a(디코드 전 실패)'}`,
      `입력 ${bytes.length}B`,
      describeError(e),
      `env: ${envFingerprint()}`,
    ].join(' | ');
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
 * 하드클린은 그런 탐지에 전혀 의존하지 않는다. 이미지를 캔버스로 다시 그려서 **완전히 새
 * 바이트 스트림으로 재인코딩**한다 — 원본 컨테이너·픽셀 데이터를 아예 안 물려받으므로
 * 포맷과 무관하게 EXIF는 처음부터 없다.
 *
 * 기본 출력은 WebP(2026-08-25, 사용자 요청으로 JPEG 기본값에서 되돌림).
 *
 *  1) EXIF — 캔버스에서 새로 만든 blob이라 애초에 EXIF 세그먼트가 없다. **품질과 무관하게
 *     항상 제거된다.**
 *  2) alpha 채널 은닉(stealth_pngcomp) — 포맷과 무관하게 흰 배경에 합성해 물리적으로
 *     없앤다(아래 renderProcessed 호출, flattenTo 옵션). **이것도 품질과 무관하게 항상
 *     제거된다** — "alpha를 255로 민다"는 코드로 흉내낼 필요가 없다.
 *  3) RGB 채널 LSB 은닉 — report_0821.md에서 실제 NAI 이미지를 전수 분석했지만 이런
 *     은닉은 발견되지 않았다(확인된 은닉 경로는 위 1·2뿐). 다만 손실 압축이 강할수록
 *     미세한 비트 패턴이 더 뭉개지므로, "혹시 있을지 모르는" RGB 은닉에 대해서만 품질이
 *     이론적으로 영향을 준다 — 품질이 100(≈무손실)에 가까울수록 그 여지가 남는다는
 *     원리적인 얘기지, 실제로 관찰된 적 있는 위협은 아니다. 예전에 WebP quality:1.0 대신
 *     JPEG를 기본값으로 택했던 것도 이 이론적 여지 때문이었다("브라우저 구현별로
 *     무손실 여부가 보장되지 않는다").
 * 즉 **확인된 은닉(EXIF·alpha)은 품질 설정과 무관하게 항상 제거된다.** 품질은 화질·용량
 * 트레이드오프로 고르면 되고, 최대 보수적으로 가고 싶을 때만 100보다 낮은 값을 쓰면 된다.
 */
const HARDCLEAN_DEFAULT_QUALITY = 1;

/**
 * 캔버스 한 번 그리기의 결과 — 이미지 크기와 "무엇이 적용됐는지" 요약을 함께 돌려준다.
 * 크레딧 되쓰기(metadata-write)가 WebP VP8X를 만들 때 실제 출력 크기를 알아야 해서 필요하다.
 */
interface CanvasPassResult extends StripResult {
  width: number;
  height: number;
  /** 실제 출력 확장자 */
  ext: 'jpg' | 'webp';
  note?: string;
}

/**
 * ⚠ 후처리(ImageOps)는 **이 한 번의 그리기에 같이 얹는다**. 별도 패스로 돌리면 하드클린
 *   결과물을 다시 디코드해서 또 인코딩하게 되어 손실이 두 번 쌓인다 — 크기 조정·워터마크가
 *   전부 renderProcessed() 안에서 끝나야 하는 이유. 위 hardCleanReencode 설명 참고.
 */
async function hardCleanReencode(bytes: Uint8Array, ops: ImageOps): Promise<CanvasPassResult> {
  const fallbackExt = 'webp' as const;
  if (!parseWebP(bytes).isWebP) {
    const detail = describeNotWebp(bytes);
    console.warn('[naisu] hardCleanReencode: WebP로 인식되지 않음 —', detail);
    return { data: bytes, status: 'not-webp', detail, width: 0, height: 0, ext: fallbackExt };
  }
  let stage = 'createImageBitmap';
  let width = 0;
  let height = 0;
  // 하드클린의 기본 출력은 WebP. 사용자가 JPEG를 명시했으면 그 값이 이긴다.
  const ext: 'jpg' | 'webp' = ops.format === 'jpg' ? 'jpg' : 'webp';
  const quality = ops.quality > 0 ? ops.quality : HARDCLEAN_DEFAULT_QUALITY;
  try {
    console.log(`[naisu] hardCleanReencode 시작: 입력 ${bytes.length}B, ops=[${opsSummary(ops) || '없음'}]`);
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/webp' }));
    ({ width, height } = bitmap);
    console.log(`[naisu] hardCleanReencode: ${stage} 완료 — ${width}x${height}`);

    stage = 'renderProcessed';
    const watermarkFontFamily = await resolveWatermarkFontFamily(ops);
    // 출력 포맷과 무관하게 흰 배경에 합성 — 하드클린은 alpha 채널 자체를 없애는 게
    // 목적이라 WebP로 낼 때도 JPEG와 똑같이 깐다(투명 영역이 검게 뭉개지는 것도 방지).
    const canvas = renderProcessed(bitmap, ops, { flattenTo: '#ffffff', watermarkFontFamily });
    bitmap.close();

    stage = `convertToBlob(${ext})`;
    const data = await encodeImage(canvas, ext === 'jpg' ? 'image/jpeg' : 'image/webp', quality);
    console.log(
      `[naisu] hardCleanReencode 완료: 출력 ${data.length}B ${canvas.width}x${canvas.height} q=${quality}`,
    );
    return {
      data,
      status: 'ok',
      width: canvas.width,
      height: canvas.height,
      ext,
      note: describeOpsResult(ops),
    };
  } catch (e) {
    const detail = [
      `실패 단계=${stage}`,
      `이미지 크기=${width > 0 ? `${width}x${height}` : 'n/a(디코드 전 실패)'}`,
      `출력 포맷=${ext} quality=${quality}`,
      `후처리=[${opsSummary(ops) || '없음'}]`,
      `입력 ${bytes.length}B`,
      describeError(e),
      `env: ${envFingerprint()}`,
    ].join(' | ');
    console.error('[naisu] hardCleanReencode 실패 — 원본을 그대로 반환합니다.', detail, e);
    return {
      data: bytes,
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
      detail,
      width,
      height,
      ext: fallbackExt,
    };
  }
}

/**
 * 클린/원본 경로에서 후처리만 따로 돌리는 패스.
 *
 * 하드클린과 달리 여기서는 재인코딩이 원래 목적이 아니었으므로, **후처리 설정이 기본값이면
 * 아예 호출되지 않는다**(runStripAndSave에서 isImageOpsIdentity로 거른다). 호출되었다는 건
 * 사용자가 크기/포맷/워터마크를 명시적으로 요구했다는 뜻이라, 재인코딩은 의도된 대가다.
 */
async function applyImageOpsPass(bytes: Uint8Array, ops: ImageOps, srcExt: 'jpg' | 'webp'): Promise<CanvasPassResult> {
  let stage = 'createImageBitmap';
  let width = 0;
  let height = 0;
  const ext: 'jpg' | 'webp' = ops.format === 'auto' ? srcExt : ops.format;
  try {
    const mime = srcExt === 'jpg' ? 'image/jpeg' : 'image/webp';
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mime }));
    ({ width, height } = bitmap);

    stage = 'renderProcessed';
    const watermarkFontFamily = await resolveWatermarkFontFamily(ops);
    // JPEG로 나갈 때만 배경을 깐다 — WebP는 알파를 그대로 살릴 수 있고,
    // 클린 모드는 (하드클린과 달리) 알파 채널을 없애는 게 목적이 아니다.
    const canvas = renderProcessed(bitmap, ops, { flattenTo: ext === 'jpg' ? '#ffffff' : null, watermarkFontFamily });
    bitmap.close();

    stage = `convertToBlob(${ext})`;
    const data = await encodeImage(
      canvas,
      ext === 'jpg' ? 'image/jpeg' : 'image/webp',
      ops.quality > 0 ? ops.quality : 1,
    );
    return {
      data,
      status: 'ok',
      width: canvas.width,
      height: canvas.height,
      ext,
      note: describeOpsResult(ops),
    };
  } catch (e) {
    const detail = [
      `실패 단계=${stage}`,
      `이미지 크기=${width > 0 ? `${width}x${height}` : 'n/a(디코드 전 실패)'}`,
      `후처리=[${opsSummary(ops) || '없음'}] 출력=${ext}`,
      describeError(e),
      `env: ${envFingerprint()}`,
    ].join(' | ');
    console.error('[naisu] applyImageOpsPass 실패 — 후처리 전 바이트를 그대로 씁니다.', detail, e);
    return {
      data: bytes,
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
      detail,
      width,
      height,
      ext: srcExt,
    };
  }
}

/** 후처리가 실제로 무엇을 했는지 한 줄로 — 패널 로그에 그대로 나간다. */
function describeOpsResult(ops: ImageOps): string | undefined {
  return ops.watermark.on && ops.watermark.text.trim() ? '워터마크' : undefined;
}

const WATERMARK_FONT_FAMILY = 'naisu-wm';

/**
 * 워터마크 커스텀 폰트를 불러와 등록하고 renderProcessed에 넘길 font-family를 돌려준다.
 * 실패해도(CORS 미허용, 네트워크 오류, 이 Chrome 버전이 self.fonts를 지원 안 함 등)
 * 조용히 undefined를 돌려 기본 폰트로 폴백한다 — 워터마크 자체가 안 뜨는 것보다는
 * 폰트만 기본값으로 뜨는 쪽이 낫다.
 */
async function resolveWatermarkFontFamily(ops: ImageOps): Promise<string | undefined> {
  if (!ops.watermark.on || !ops.watermark.fontUrl.trim()) return undefined;
  // tsconfig의 lib가 "DOM"이라(content/popup과 공유) self는 Window 타입으로 잡혀 .fonts가
  // 없다고 나온다 — 실제로는 service worker 전역(WorkerGlobalScope)의 FontFaceSource라
  // 런타임에는 존재한다. 지원 안 하는 옛 Chrome에서는 undefined라 아래에서 걸러진다.
  const fontsSet = (self as unknown as { fonts?: FontFaceSet }).fonts;
  if (!fontsSet) {
    console.warn('[naisu] 워터마크 커스텀 폰트: 이 Chrome 버전은 service worker의 self.fonts를 지원하지 않습니다');
    return undefined;
  }
  try {
    await loadWatermarkFont(ops.watermark.fontUrl, WATERMARK_FONT_FAMILY, fontsSet);
    return WATERMARK_FONT_FAMILY;
  } catch (e) {
    console.warn('[naisu] 워터마크 커스텀 폰트를 불러오지 못해 기본 폰트로 대체합니다', describeError(e));
    return undefined;
  }
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

interface StripAndSaveResult {
  saved: string[];
  items: SavedItem[];
  errors: string[];
  stripStatus?: StripStatusReport;
  opsNote?: string;
}

// ---------------------------------------------------------------------------
// 저장 결과 확인 (downloads.onChanged)
//
// 예전에는 chrome.downloads.download()가 id를 돌려주면 그걸로 성공으로 간주했다.
// 그 id는 "다운로드를 시작했다"는 뜻일 뿐이라, 디스크가 가득 찼거나 경로가 막혀
// interrupted로 끝나도 패널에는 "✔ 저장됨"이 찍혔다 — UI가 사실이 아닌 걸 말하고 있었다.
// 이제 완료/중단 이벤트를 기다렸다가 실제 결과를 돌려준다.
// ---------------------------------------------------------------------------

/** 큰 파일 + 느린 디스크를 감안한 상한. 넘으면 "확인 못 함"으로 두고 실패로 단정하지 않는다. */
const DOWNLOAD_VERIFY_TIMEOUT_MS = 45_000;

interface VerifyResult {
  ok: boolean;
  error?: string;
  bytes?: number;
}

function verifyDownload(id: number): Promise<VerifyResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: VerifyResult): void => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(r);
    };

    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== id) return;
      const state = delta.state?.current;
      if (state === 'complete') {
        finish({ ok: true });
      } else if (state === 'interrupted') {
        finish({ ok: false, error: describeInterrupt(delta.error?.current) });
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);

    const timer = setTimeout(() => {
      // 타임아웃은 "실패"가 아니라 "확인 못 함"이다. 실제로는 성공했을 수 있으므로
      // ok:true로 두되 사유를 남겨서, 로그만 보고도 구분할 수 있게 한다.
      finish({ ok: true, error: `저장 완료를 ${DOWNLOAD_VERIFY_TIMEOUT_MS / 1000}초 안에 확인하지 못했습니다(실패는 아닐 수 있음)` });
    }, DOWNLOAD_VERIFY_TIMEOUT_MS);

    // download()가 반환되기 전에 이미 끝났을 수도 있다 — 현재 상태를 한 번 조회해서 놓치지 않는다.
    void chrome.downloads.search({ id }).then((items) => {
      const it = items[0];
      if (!it) return;
      if (it.state === 'complete') finish({ ok: true, bytes: it.fileSize || it.bytesReceived });
      else if (it.state === 'interrupted') finish({ ok: false, error: describeInterrupt(it.error) });
    });
  });
}

/** chrome.downloads의 InterruptReason을 사람이 읽을 한국어로. 모르는 값은 원문 그대로 남긴다. */
function describeInterrupt(reason: string | undefined): string {
  const map: Record<string, string> = {
    FILE_ACCESS_DENIED: '파일 접근이 거부되었습니다 (권한 또는 다른 프로그램이 파일을 잡고 있음)',
    FILE_NO_SPACE: '디스크 공간이 부족합니다',
    FILE_NAME_TOO_LONG: '파일 이름이 너무 깁니다 — 파일명 템플릿을 줄여 주세요',
    FILE_TOO_LARGE: '파일이 너무 큽니다',
    FILE_VIRUS_INFECTED: '보안 프로그램이 파일을 차단했습니다',
    FILE_TRANSIENT_ERROR: '일시적인 파일 오류입니다 — 다시 시도해 주세요',
    FILE_BLOCKED: '브라우저 정책이 저장을 차단했습니다',
    FILE_FAILED: '파일을 쓰지 못했습니다',
    USER_CANCELED: '사용자가 취소했습니다',
    USER_SHUTDOWN: '브라우저가 종료되어 중단되었습니다',
    SERVER_FAILED: '데이터 URL을 읽는 데 실패했습니다',
  };
  if (!reason) return '알 수 없는 이유로 중단되었습니다';
  return map[reason] ?? `중단됨 (${reason})`;
}

/**
 * 바이트 배열 하나를 (모드에 따라 스트리핑 →) chrome.downloads.download로 저장하는 공유 파이프라인.
 * handleDownload()(자동 배치/수동 저장, base64로 온 새 생성 이미지)와 handleStripFiles()
 * (N09, 예전에 저장해 둔 파일을 일괄 클린)가 이 함수 하나를 공유한다 — 스트리핑 로직 자체는
 * 절대 중복 구현하지 않는다. logLabel은 호출자별로 콘솔 로그를 구분하기 위한 접두어일 뿐,
 * 파이프라인 동작 자체는 호출자와 무관하게 항상 동일하다.
 */
async function runStripAndSave(
  raw: Uint8Array,
  mode: DownloadMode,
  folder: string,
  filename: string,
  keepIccp: boolean,
  logLabel: string,
  conflictAction: ConflictAction = 'uniquify',
  ops: ImageOps = DEFAULT_IMAGE_OPS,
): Promise<StripAndSaveResult> {
  // mode 별로 저장할 (data, suffix, 확장자/MIME) 작업 목록
  const MIME_BY_EXT = { webp: 'image/webp', jpg: 'image/jpeg' } as const;
  const tasks: Array<{ data: Uint8Array; suffix: string; ext: keyof typeof MIME_BY_EXT }> = [];
  let stripStatus: StripStatusReport | undefined;
  let opsNote: string | undefined;
  // ⚠ 후처리는 raw(원본)에는 절대 적용하지 않는다 — 이 규칙을 강제하는 곳은 여기 한 군데뿐이다.
  const opsActive = mode !== 'raw' && !isImageOpsIdentity(ops);
  if (mode === 'hardclean' || mode === 'clean' || mode === 'both') {
    const rawInfo = parseWebP(raw);
    console.log(
      `[naisu] ${logLabel}: raw 청크=[${rawInfo.chunks.map((c) => c.fourcc).join(',')}] truncated=${rawInfo.truncated} vp8xFlags=${rawInfo.vp8xFlags?.toString(16) ?? 'n/a'}`,
    );
    const riffCleaned = stripMetadata(raw, { keepIccp });
    // 재인코딩이 실제로 성공했을 때만 jpg — not-webp/error로 폴백해 원본 webp 바이트를
    // 그대로 반환한 경우까지 .jpg로 저장하면 확장자와 실제 내용이 어긋난다.
    let ext: keyof typeof MIME_BY_EXT = 'webp';
    let outW = 0;
    let outH = 0;
    let result: StripResult;
    if (mode === 'hardclean') {
      const hc = await hardCleanReencode(riffCleaned, ops);
      result = hc;
      if (hc.status === 'ok') {
        ext = hc.ext;
        outW = hc.width;
        outH = hc.height;
        opsNote = hc.note;
      }
    } else {
      // '둘 다'는 하드클린이 아니라 항상 (기존)클린 + 원본 조합
      result = await stripStealthAlpha(riffCleaned);
    }
    let data = result.data;

    // 하드클린은 위 한 번의 캔버스 패스에서 후처리까지 끝냈다. 클린은 재인코딩을 안 하므로
    // 후처리가 필요할 때만 여기서 별도 패스를 돈다.
    if (opsActive && mode !== 'hardclean' && result.status !== 'not-webp') {
      const processed = await applyImageOpsPass(data, ops, ext);
      if (processed.status === 'ok') {
        data = processed.data;
        ext = processed.ext;
        outW = processed.width;
        outH = processed.height;
        opsNote = processed.note;
      } else {
        opsNote = `후처리 실패 — 후처리 전 파일로 저장했습니다 (${processed.error ?? '알 수 없는 오류'})`;
      }
    }

    if (ops.credit.on && ops.credit.text.trim()) {
      const written = writeCredit(data, ext, ops.credit.text.trim(), outW, outH);
      if (written.status === 'ok') {
        data = written.data;
      } else {
        console.warn(`[naisu] ${logLabel}: 크레딧 되쓰기 실패 (${written.status}) — ${written.detail ?? ''}`);
        opsNote = [opsNote, `크레딧 되쓰기 실패(${written.status})`].filter(Boolean).join(' · ');
      }
    }

    tasks.push({ data, suffix: '', ext }); // 클린류가 기본(접미사 없음)
    stripStatus = rawInfo.truncated
      ? {
          mode,
          level: 'bad',
          message: `⚠ WebP 컨테이너 파싱이 중간에 손상/절단되어 EXIF 등 일부 청크를 확인하지 못했습니다 — 메타데이터가 남아있을 수 있습니다. (콘솔 로그 참고)`,
          detail: `raw 청크=[${rawInfo.chunks.map((c) => c.fourcc).join(',')}] rawBytesLength=${raw.length}`,
        }
      : describeStripStatus(mode, !!rawInfo.getChunk('EXIF'), result);
    // 콘솔에 찍히는 detail 하나만 보고도 고칠 수 있게, strip 함수 내부 진단 앞에
    // 이 요청 자체의 컨텍스트(어떤 모드/파일/원본이었는지)를 붙여서 완결된 문장으로 만든다.
    if (stripStatus.detail) {
      stripStatus.detail =
        `요청: mode=${mode} filename="${filename}" folder="${folder}" keepIccp=${keepIccp} | ` +
        `raw: ${raw.length}B, 청크=[${rawInfo.chunks.map((c) => c.fourcc).join(',')}], truncated=${rawInfo.truncated}, vp8xFlags=0x${rawInfo.vp8xFlags?.toString(16) ?? 'n/a'} | ` +
        `riffCleaned: ${riffCleaned.length}B | ` +
        stripStatus.detail;
      console.warn(`[naisu] ${logLabel}: stripStatus detail —`, stripStatus.detail);
    }
  }
  if (mode === 'raw' || mode === 'both') {
    tasks.push({ data: raw, suffix: mode === 'both' ? '_raw' : '', ext: 'webp' }); // both면 _raw 접미사
  }

  const saved: string[] = [];
  const items: SavedItem[] = [];
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
        conflictAction,
        saveAs: conflictAction === 'prompt',
      });
      if (typeof id !== 'number') {
        console.warn(`[naisu] ${logLabel}: chrome.downloads.download 거부됨 — ${path}`);
        errors.push(`다운로드 거부: ${path}`);
        items.push({ path, downloadId: null, ok: false, error: '브라우저가 다운로드를 거부했습니다' });
        continue;
      }
      // ⭐ 여기서 실제 완료를 기다린다 — id를 받은 것만으로 성공이라고 하지 않는다.
      const verified = await verifyDownload(id);
      items.push({ path, downloadId: id, ok: verified.ok, error: verified.error, bytes: verified.bytes ?? t.data.length });
      if (verified.ok) {
        saved.push(path);
        if (verified.error) console.warn(`[naisu] ${logLabel}: ${path} — ${verified.error}`);
      } else {
        console.error(`[naisu] ${logLabel}: 저장 실패 — ${path}: ${verified.error}`);
        errors.push(`${path}: ${verified.error}`);
      }
    } catch (e) {
      console.error(`[naisu] ${logLabel}: chrome.downloads.download 예외 — ${path}`, describeError(e));
      errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      items.push({ path, downloadId: null, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { saved, items, errors, stripStatus, opsNote };
}

async function handleDownload(req: DownloadReq): Promise<DownloadResponse> {
  const { bytes, mode, folder, filename, strip, conflictAction, imageOps } = req.payload;
  const raw = b64ToBytes(bytes);
  const ops = mergeImageOps(imageOps);
  console.log(
    `[naisu] handleDownload 시작: mode=${mode} filename="${filename}" folder="${folder}" keepIccp=${strip.keepIccp} conflict=${conflictAction ?? 'uniquify'} ops=[${opsSummary(ops) || '없음'}] base64Length=${bytes.length} rawBytesLength=${raw.length}`,
  );
  const { saved, items, errors, stripStatus, opsNote } = await runStripAndSave(
    raw,
    mode,
    folder,
    filename,
    strip.keepIccp,
    'handleDownload',
    conflictAction ?? 'uniquify',
    ops,
  );
  console.log(`[naisu] handleDownload 종료: saved=${JSON.stringify(saved)} errors=${JSON.stringify(errors)}`);
  return errors.length ? { saved, items, errors, stripStatus, opsNote } : { saved, items, stripStatus, opsNote };
}

/** 저장된 파일을 탐색기/Finder에서 보여준다 — 결과 줄의 "폴더 열기". */
/** content script에는 없는 chrome.runtime.openOptionsPage를 대신 호출한다. */
function handleOpenOptionsPage(): OkResponse {
  try {
    void chrome.runtime.openOptionsPage();
    return { ok: true };
  } catch (e) {
    console.error('[naisu] chrome.runtime.openOptionsPage 실패', describeError(e));
    return { ok: false, reason: describeError(e) };
  }
}

function handleShowFile(payload: ShowFilePayload): OkResponse {
  try {
    chrome.downloads.show(payload.downloadId);
    return { ok: true };
  } catch (e) {
    console.error('[naisu] chrome.downloads.show 실패', describeError(e));
    return { ok: false, reason: '파일을 찾지 못했습니다 — 이미 옮기거나 지웠을 수 있습니다' };
  }
}

/**
 * 배치 매니페스트 — 클린 저장은 이미지에서 프롬프트·시드를 지운다. 그 짝으로,
 * 재현에 필요한 정보를 배치 폴더에 CSV 한 개로 남긴다.
 * 이미지와 같은 경로 규칙(safe 처리)을 그대로 쓴다.
 */
async function handleManifest(payload: ManifestPayload): Promise<OkResponse> {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '');
  const folder = payload.folder.split('/').map(safe).filter(Boolean).join('/');
  const path = `${folder}/${safe(payload.name || 'manifest')}.csv`;
  try {
    // BOM을 붙여야 Excel이 UTF-8 한글을 깨뜨리지 않는다 — 프롬프트에 한글이 섞이는 게 보통이다.
    const url = `data:text/csv;charset=utf-8;base64,${bytesToB64(new TextEncoder().encode(`﻿${payload.csv}`))}`;
    const id = await chrome.downloads.download({ url, filename: path, conflictAction: 'uniquify', saveAs: false });
    if (typeof id !== 'number') return { ok: false, reason: '매니페스트 저장이 거부되었습니다' };
    const verified = await verifyDownload(id);
    console.log(`[naisu] 매니페스트 저장 ${verified.ok ? '완료' : '실패'} — ${path}`);
    return verified.ok ? { ok: true } : { ok: false, reason: verified.error };
  } catch (e) {
    console.error('[naisu] 매니페스트 저장 실패', describeError(e));
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * N09 — 예전에 원본으로 저장해 둔 파일들을 나중에 일괄로 하드클린/클린 처리.
 * 스트리핑 파이프라인은 handleDownload()와 완전히 같은 runStripAndSave()를 그대로 재사용하고,
 * 파일마다 순차 처리한다(Promise.all로 동시에 돌리면 base64 문자열 여러 개를 동시에
 * 메모리에 붙들게 되어 대량 파일 처리 시 메모리 압박이 커진다).
 */
async function handleStripFiles(payload: StripFilesPayload): Promise<StripFilesResponse> {
  console.log(
    `[naisu] handleStripFiles 시작: files=${payload.files.length} mode=${payload.mode} folder="${payload.folder}" keepIccp=${payload.keepIccp}`,
  );
  const results: StripFilesResponse['results'] = [];
  for (const file of payload.files) {
    try {
      const raw = b64ToBytes(file.bytes);
      const { saved, errors, stripStatus } = await runStripAndSave(
        raw,
        payload.mode,
        payload.folder,
        file.name,
        payload.keepIccp,
        `handleStripFiles[${file.name}]`,
      );
      results.push({
        name: file.name,
        saved,
        error: errors.length ? errors.join('; ') : undefined,
        stripStatus,
      });
    } catch (e) {
      // 파일 하나가 깨진 base64거나 예상치 못한 예외를 던져도 나머지 파일 처리를 막지 않는다 —
      // 어느 파일이 왜 실패했는지가 항상 결과에 남아야 한다(실패를 삼키지 않는다).
      console.error(`[naisu] handleStripFiles: "${file.name}" 처리 중 예외`, describeError(e));
      results.push({ name: file.name, saved: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  console.log(
    `[naisu] handleStripFiles 종료: ${JSON.stringify(results.map((r) => ({ name: r.name, saved: r.saved.length, error: r.error })))}`,
  );
  return { results };
}

/**
 * N03 — 배치 완료/실패 브라우저 알림. Discord 웹훅을 설정하지 않은 사용자를 위한 기본 통보 수단.
 * 보내는 쪽(content script)에서도 설정을 확인하지만, 진입점이 늘어나도 설정이 항상 지켜지도록
 * 여기서도 다시 한번 getSettings().notifications[kind]를 확인한다 — 꺼져 있으면 표시하지 않는다.
 */
async function handleNotify(payload: NotifyPayload): Promise<OkResponse> {
  const settings = await getSettings();
  if (!settings.notifications[payload.kind]) {
    console.log(`[naisu] naisu.notify: kind=${payload.kind} 알림이 설정에서 꺼져 있어 표시하지 않음`);
    return { ok: false, reason: `알림 종류(${payload.kind})가 설정에서 꺼져 있음` };
  }
  if (payload.kind === 'error') {
    // 실패 알림은 배지 색도 빨강으로 — 브라우저 알림을 놓쳐도 툴바 아이콘만 보고 알 수 있게.
    chrome.action.setBadgeBackgroundColor({ color: '#d91919' });
  }
  try {
    // 알림에서 바로 이어질 행동을 붙인다. chrome.notifications는 버튼 2개까지만 받는다.
    const actions = (payload.actions ?? []).slice(0, 2);
    const buttons = actions.map((a) => ({ title: a === 'openFolder' ? '폴더 열기' : '다시 시도' }));
    const id = `naisu-${payload.kind}-${notifySeq++}`;
    notifyActions.set(id, { actions, downloadId: payload.downloadId });
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('src/assets/icon-128.png'),
      title: payload.title,
      message: payload.message,
      ...(buttons.length ? { buttons } : {}),
    });
    console.log(`[naisu] naisu.notify: kind=${payload.kind} title="${payload.title}" 버튼=${buttons.length}개 표시함`);
    return { ok: true };
  } catch (e) {
    console.error('[naisu] naisu.notify: chrome.notifications.create 실패', describeError(e));
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 알림 버튼 배선. 알림 id → 무슨 버튼이 달렸는지를 여기 보관한다.
 * SW는 언제든 종료될 수 있어서 이 맵은 휘발성이다 — 되살아난 뒤 눌린 버튼은 조용히 무시되지 않고
 * 사유를 콘솔에 남긴다(알림은 몇 초 안에 사라지므로 실무상 거의 문제되지 않는다).
 */
let notifySeq = 0;
const notifyActions = new Map<string, { actions: Array<'openFolder' | 'retry'>; downloadId?: number }>();

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  void (async () => {
    const entry = notifyActions.get(notificationId);
    if (!entry) {
      console.warn(`[naisu] 알림 버튼: 알 수 없는 알림 id=${notificationId} (service worker가 재시작됐을 수 있습니다)`);
      return;
    }
    const action = entry.actions[buttonIndex];
    if (action === 'openFolder' && entry.downloadId !== undefined) {
      handleShowFile({ downloadId: entry.downloadId });
    } else if (action === 'retry') {
      const tabId = await activeNaiTabId();
      if (tabId === null) {
        notifyCommandFailed('NovelAI 이미지 탭이 열려 있지 않아 다시 시도할 수 없습니다.');
        return;
      }
      await sendToTab(tabId, 'naisu.batch.resume');
    }
    chrome.notifications.clear(notificationId);
    notifyActions.delete(notificationId);
  })();
});

chrome.notifications.onClosed.addListener((id) => notifyActions.delete(id));

async function handleWebhook(req: WebhookReq): Promise<WebhookResponse> {
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

/**
 * 절전 방지. 'system' 수준이라 화면은 꺼져도 되고 시스템만 깨어 있게 한다 —
 * 화면을 강제로 켜 두는 것보다 덜 침습적이면서, 절전으로 탭이 멈춰 배치가 끊기는 건 막는다.
 * 배치가 끝나면 반드시 해제해야 하므로 실패해도 조용히 넘어가지 않고 상태를 돌려준다.
 */
function handlePower(on: boolean): OkResponse {
  try {
    if (on) chrome.power.requestKeepAwake('system');
    else chrome.power.releaseKeepAwake();
    console.log(`[naisu] 절전 방지 ${on ? '요청' : '해제'}`);
    return { ok: true };
  } catch (e) {
    console.error('[naisu] 절전 방지 처리 실패', describeError(e));
    return { ok: false, reason: describeError(e) };
  }
}

chrome.runtime.onMessage.addListener((req: NaisuMessage, _sender, sendResponse) => {
  (async () => {
    try {
      if (req.type === 'naisu.download') {
        sendResponse(await handleDownload(req));
      } else if (req.type === 'naisu.webhook') {
        sendResponse(await handleWebhook(req));
      } else if (req.type === 'naisu.power') {
        sendResponse(handlePower(req.payload.on));
      } else if (req.type === 'naisu.notify') {
        sendResponse(await handleNotify(req.payload));
      } else if (req.type === 'naisu.strip.files') {
        sendResponse(await handleStripFiles(req.payload));
      } else if (req.type === 'naisu.download.show') {
        sendResponse(handleShowFile(req.payload));
      } else if (req.type === 'naisu.download.manifest') {
        sendResponse(await handleManifest(req.payload));
      } else if (req.type === 'naisu.options.open') {
        sendResponse(handleOpenOptionsPage());
      } else if (req.type === 'naisu.badge') {
        chrome.action.setBadgeText({ text: req.payload.text });
        if (req.payload.color) {
          chrome.action.setBadgeBackgroundColor({ color: req.payload.color });
        }
        sendResponse({ ok: true });
      } else {
        // content script 대상 메시지가 여기로 올 일은 없지만, 응답 없이 끝내면
        // 호출한 쪽이 원인을 알 수 없게 되므로 항상 회신한다.
        sendResponse({ ok: false, reason: `service worker가 처리하지 않는 메시지: ${String(req.type)}` });
      }
    } catch (e) {
      sendResponse({ error: String(e) });
    }
  })();
  return true; // async
});

/**
 * N01: 단축키 배선.
 *
 * ⚠ 자동 배치는 runBatch() 안에서 약관 동의를 확인한다. 단축키가 그 게이트를 우회하지
 *   않도록, 여기서는 새 실행 경로를 만들지 않고 기존 naisu.batch.* 메시지만 보낸다.
 */
const NAI_IMAGE_URL = 'https://novelai.net/image';

async function activeNaiTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id != null && tab.url?.startsWith(NAI_IMAGE_URL) ? tab.id : null;
}

/** 단축키를 눌렀는데 아무 일도 안 일어나면 사용자가 원인을 알 수 없으므로 알림으로 알린다. */
function notifyCommandFailed(message: string): void {
  console.warn(`[naisu] 단축키 처리 실패 — ${message}`);
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('src/assets/icon-128.png'),
      title: 'NAISU',
      message,
    });
  } catch (e) {
    console.error('[naisu] 단축키 실패 알림도 표시하지 못했습니다', describeError(e));
  }
}

chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    const tabId = await activeNaiTabId();
    if (tabId === null) {
      notifyCommandFailed('NovelAI 이미지 탭에서만 단축키를 쓸 수 있습니다.');
      return;
    }
    try {
      switch (command) {
        case 'naisu-toggle-batch': {
          // 실행 중이면 일시정지, 아니면 시작 — 시작은 반드시 batch.start를 거쳐
          // content script의 약관 게이트를 타게 한다.
          const state = await sendToTab(tabId, 'naisu.query.anlas');
          if (state?.state.running) await sendToTab(tabId, 'naisu.batch.pause');
          else await sendToTab(tabId, 'naisu.batch.start');
          break;
        }
        case 'naisu-save-image':
          await sendToTab(tabId, 'naisu.manual.download');
          break;
        case 'naisu-stop-batch':
          await sendToTab(tabId, 'naisu.batch.stop');
          break;
        default:
          console.warn(`[naisu] 알 수 없는 단축키: ${command}`);
          return;
      }
      console.log(`[naisu] 단축키 처리됨: ${command}`);
    } catch (e) {
      notifyCommandFailed(
        'NAISU가 페이지에 아직 붙지 않았습니다. NovelAI 탭을 새로고침한 뒤 다시 시도해 주세요.',
      );
      console.error('[naisu] 단축키 메시지 전송 실패', describeError(e));
    }
  })();
});

console.log(`[naisu] service worker booted — ${envFingerprint()}`);
