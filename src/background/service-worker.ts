/**
 * MV3 service worker.
 * - content script로부터 다운로드 요청을 받아 chrome.downloads로 위임
 * - Discord 웹훅 호출 (CORS 회피)
 *
 * 주의: MV3 SW에는 URL.createObjectURL이 없습니다 (Chrome 일부 버전).
 * 따라서 data: URL로 다운로드합니다.
 */

import { stripMetadata, parseWebP } from '../lib/webp-riff';
import { getSettings } from '../lib/storage';
import type { DownloadMode } from '../lib/storage';
import { sendToTab } from '../lib/messages';
import type {
  DownloadPayload,
  DownloadResponse,
  NaisuMessage,
  NotifyPayload,
  OkResponse,
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
  let width = 0;
  let height = 0;
  try {
    console.log(`[naisu] hardCleanReencode 시작: 입력 ${bytes.length}B`);
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/webp' }));
    ({ width, height } = bitmap);
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
    const detail = [
      `실패 단계=${stage}`,
      `이미지 크기=${width > 0 ? `${width}x${height}` : 'n/a(디코드 전 실패)'}`,
      `JPEG quality=${HARDCLEAN_JPEG_QUALITY}`,
      `입력 ${bytes.length}B`,
      describeError(e),
      `env: ${envFingerprint()}`,
    ].join(' | ');
    console.error('[naisu] hardCleanReencode 실패 — 원본을 그대로 반환합니다.', detail, e);
    return { data: bytes, status: 'error', error: e instanceof Error ? e.message : String(e), detail };
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
  errors: string[];
  stripStatus?: StripStatusReport;
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
): Promise<StripAndSaveResult> {
  // mode 별로 저장할 (data, suffix, 확장자/MIME) 작업 목록
  const MIME_BY_EXT = { webp: 'image/webp', jpg: 'image/jpeg' } as const;
  const tasks: Array<{ data: Uint8Array; suffix: string; ext: keyof typeof MIME_BY_EXT }> = [];
  let stripStatus: StripStatusReport | undefined;
  if (mode === 'hardclean' || mode === 'clean' || mode === 'both') {
    const rawInfo = parseWebP(raw);
    console.log(
      `[naisu] ${logLabel}: raw 청크=[${rawInfo.chunks.map((c) => c.fourcc).join(',')}] truncated=${rawInfo.truncated} vp8xFlags=${rawInfo.vp8xFlags?.toString(16) ?? 'n/a'}`,
    );
    const riffCleaned = stripMetadata(raw, { keepIccp });
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
        console.warn(`[naisu] ${logLabel}: chrome.downloads.download 거부됨 — ${path}`);
        errors.push(`다운로드 거부: ${path}`);
      }
    } catch (e) {
      console.error(`[naisu] ${logLabel}: chrome.downloads.download 예외 — ${path}`, describeError(e));
      errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { saved, errors, stripStatus };
}

async function handleDownload(req: DownloadReq): Promise<DownloadResponse> {
  const { bytes, mode, folder, filename, strip } = req.payload;
  const raw = b64ToBytes(bytes);
  console.log(
    `[naisu] handleDownload 시작: mode=${mode} filename="${filename}" folder="${folder}" keepIccp=${strip.keepIccp} base64Length=${bytes.length} rawBytesLength=${raw.length}`,
  );
  const { saved, errors, stripStatus } = await runStripAndSave(raw, mode, folder, filename, strip.keepIccp, 'handleDownload');
  console.log(`[naisu] handleDownload 종료: saved=${JSON.stringify(saved)} errors=${JSON.stringify(errors)}`);
  return errors.length ? { saved, errors, stripStatus } : { saved, stripStatus };
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
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('src/assets/icon-128.png'),
      title: payload.title,
      message: payload.message,
    });
    console.log(`[naisu] naisu.notify: kind=${payload.kind} title="${payload.title}" 표시함`);
    return { ok: true };
  } catch (e) {
    console.error('[naisu] naisu.notify: chrome.notifications.create 실패', describeError(e));
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

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
