/**
 * 메타데이터 되쓰기 — 스트리핑의 반대 방향.
 *
 * 클린/하드클린은 이미지에서 생성 정보를 전부 지운다. 그런데 "프롬프트는 숨기고 싶지만
 * 내 서명 한 줄은 남기고 싶다"는 요구는 그와 충돌하지 않는다. 여기서는 **사용자가 직접
 * 적은 한 줄만** 새로 써 넣는다 — 원본 EXIF를 되살리는 기능이 아니다(그건 스트리핑을
 * 무의미하게 만든다).
 *
 * 지원 포맷:
 *   JPEG — COM(주석) 세그먼트. 규격이 단순하고 어떤 뷰어/exiftool에서도 읽힌다.
 *   WebP — EXIF 청크(TIFF IFD0의 ImageDescription). VP8X가 없으면 만들어서 끼워 넣는다.
 *
 * 실행 컨텍스트: service worker (저장 직전). 실패는 삼키지 않고 상태로 돌려준다.
 */

const ASCII = new TextEncoder();

export type WriteStatus = 'ok' | 'too-long' | 'unsupported' | 'error';

export interface WriteResult {
  data: Uint8Array;
  status: WriteStatus;
  detail?: string;
}

/** JPEG COM 세그먼트 길이 필드는 16비트라 본문은 65533바이트를 넘을 수 없다. */
const JPEG_COM_MAX = 65_533;

/**
 * JPEG SOI 바로 뒤에 COM 세그먼트를 끼워 넣는다.
 * APP0(JFIF) 앞에 와도 규격상 문제없지만, 관례를 따라 APP0/APP1 뒤에 넣는다.
 */
export function writeJpegComment(bytes: Uint8Array, text: string): WriteResult {
  const body = ASCII.encode(text);
  if (body.length > JPEG_COM_MAX) {
    return { data: bytes, status: 'too-long', detail: `COM 본문 ${body.length}B > ${JPEG_COM_MAX}B` };
  }
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { data: bytes, status: 'unsupported', detail: 'SOI(FFD8)로 시작하지 않아 JPEG가 아님' };
  }

  // SOI 다음의 APPn 세그먼트들을 건너뛴다 (FFE0~FFEF)
  let insertAt = 2;
  while (insertAt + 4 <= bytes.length && bytes[insertAt] === 0xff) {
    const marker = bytes[insertAt + 1]!;
    if (marker < 0xe0 || marker > 0xef) break;
    const segLen = (bytes[insertAt + 2]! << 8) | bytes[insertAt + 3]!;
    if (segLen < 2 || insertAt + 2 + segLen > bytes.length) break;
    insertAt += 2 + segLen;
  }

  const segment = new Uint8Array(4 + body.length);
  segment[0] = 0xff;
  segment[1] = 0xfe; // COM
  const len = body.length + 2;
  segment[2] = (len >> 8) & 0xff;
  segment[3] = len & 0xff;
  segment.set(body, 4);

  const out = new Uint8Array(bytes.length + segment.length);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(segment, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + segment.length);
  return { data: out, status: 'ok' };
}

/**
 * ImageDescription 하나만 들어 있는 최소 TIFF 스트림을 만든다.
 * WebP EXIF 청크의 payload는 "Exif\0\0" 접두사 없이 TIFF 헤더부터 시작한다(libwebp와 동일).
 *
 *   0  "II" 0x002A  IFD0 offset(=8)
 *   8  entryCount(1) | entry(12B) | nextIFD(0)
 *   26 ASCII 데이터 (NUL 종단)
 */
export function buildExifImageDescription(text: string): Uint8Array {
  const body = ASCII.encode(text);
  const value = new Uint8Array(body.length + 1); // NUL 종단
  value.set(body, 0);

  const IFD_OFFSET = 8;
  const IFD_SIZE = 2 + 12 + 4;
  const DATA_OFFSET = IFD_OFFSET + IFD_SIZE;
  const inline = value.length <= 4;
  const total = DATA_OFFSET + (inline ? 0 : value.length);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  // TIFF 헤더 (little-endian)
  out[0] = 0x49;
  out[1] = 0x49;
  view.setUint16(2, 0x002a, true);
  view.setUint32(4, IFD_OFFSET, true);
  // IFD0
  view.setUint16(IFD_OFFSET, 1, true); // entry 1개
  const e = IFD_OFFSET + 2;
  view.setUint16(e, 0x010e, true); // ImageDescription
  view.setUint16(e + 2, 2, true); // type = ASCII
  view.setUint32(e + 4, value.length, true);
  if (inline) out.set(value, e + 8);
  else view.setUint32(e + 8, DATA_OFFSET, true);
  view.setUint32(IFD_OFFSET + 2 + 12, 0, true); // 다음 IFD 없음
  if (!inline) out.set(value, DATA_OFFSET);
  return out;
}

const FOURCC_BYTES = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const VP8X_EXIF_FLAG = 0x08;

/**
 * WebP에 EXIF 청크를 붙인다. VP8X가 없으면(캔버스가 만든 단순 VP8/VP8L 파일) 규격에 맞는
 * VP8X를 만들어 맨 앞에 끼워 넣고 EXIF 비트를 켠다 — 그래야 뷰어가 EXIF를 읽는다.
 *
 * 이미 EXIF 청크가 있으면 교체한다(중복으로 두 개가 남으면 어느 쪽이 읽힐지 알 수 없다).
 */
export function writeWebpExif(bytes: Uint8Array, text: string, width: number, height: number): WriteResult {
  try {
    const TEXT = new TextDecoder('latin1');
    if (bytes.length < 12 || TEXT.decode(bytes.subarray(0, 4)) !== 'RIFF' || TEXT.decode(bytes.subarray(8, 12)) !== 'WEBP') {
      return { data: bytes, status: 'unsupported', detail: 'RIFF/WEBP 헤더가 아님' };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // 기존 청크를 (EXIF 제외하고) 순서대로 모은다
    const parts: Uint8Array[] = [];
    let hasVp8x = false;
    let off = 12;
    while (off + 8 <= bytes.length) {
      const fourcc = TEXT.decode(bytes.subarray(off, off + 4));
      const size = view.getUint32(off + 4, true);
      const padded = 8 + size + (size & 1);
      if (off + padded > bytes.length) break;
      if (fourcc === 'VP8X') hasVp8x = true;
      if (fourcc !== 'EXIF') parts.push(bytes.subarray(off, off + padded));
      off += padded;
    }
    if (parts.length === 0) {
      return { data: bytes, status: 'unsupported', detail: '이미지 청크를 찾지 못함' };
    }

    if (hasVp8x) {
      // 첫 청크가 VP8X — flags 바이트의 EXIF 비트를 켠다 (원본을 건드리지 않게 복사본에)
      const vp8x = new Uint8Array(parts[0]!);
      vp8x[8] = (vp8x[8]! | VP8X_EXIF_FLAG) & 0xff;
      parts[0] = vp8x;
    } else {
      const vp8x = new Uint8Array(8 + 10);
      vp8x.set(FOURCC_BYTES('VP8X'), 0);
      new DataView(vp8x.buffer).setUint32(4, 10, true);
      vp8x[8] = VP8X_EXIF_FLAG;
      const put24 = (at: number, v: number) => {
        vp8x[at] = v & 0xff;
        vp8x[at + 1] = (v >> 8) & 0xff;
        vp8x[at + 2] = (v >> 16) & 0xff;
      };
      put24(12, Math.max(0, width - 1)); // canvas width - 1
      put24(15, Math.max(0, height - 1));
      parts.unshift(vp8x);
    }

    const exifPayload = buildExifImageDescription(text);
    const exifChunk = new Uint8Array(8 + exifPayload.length + (exifPayload.length & 1));
    exifChunk.set(FOURCC_BYTES('EXIF'), 0);
    new DataView(exifChunk.buffer).setUint32(4, exifPayload.length, true);
    exifChunk.set(exifPayload, 8);
    parts.push(exifChunk);

    const bodySize = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(12 + bodySize);
    out.set(FOURCC_BYTES('RIFF'), 0);
    new DataView(out.buffer).setUint32(4, 4 + bodySize, true);
    out.set(FOURCC_BYTES('WEBP'), 8);
    let w = 12;
    for (const p of parts) {
      out.set(p, w);
      w += p.length;
    }
    return { data: out, status: 'ok' };
  } catch (e) {
    return {
      data: bytes,
      status: 'error',
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}

/** 확장자에 맞는 되쓰기 경로를 골라 준다. */
export function writeCredit(
  bytes: Uint8Array,
  ext: 'jpg' | 'webp',
  text: string,
  width: number,
  height: number,
): WriteResult {
  if (!text.trim()) return { data: bytes, status: 'ok' };
  return ext === 'jpg'
    ? writeJpegComment(bytes, text)
    : writeWebpExif(bytes, text, width, height);
}
