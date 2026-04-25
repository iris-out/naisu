/**
 * WebP RIFF 컨테이너 파서/리라이터.
 *
 * NAI가 만든 webp는 다음 청크를 가집니다.
 *   VP8X (10B) - 확장 헤더, flags 바이트에 EXIF/XMP/ICCP/Alpha/Anim 비트
 *   VP8L 또는 VP8/VP8X bitstream - 이미지 데이터
 *   ICCP (선택) - 컬러 프로파일
 *   ANIM/ANMF (선택) - 애니메이션 프레임
 *   ALPH (선택) - 알파 채널
 *   EXIF (선택) - EXIF IFD (NAI 메타데이터가 들어있는 곳)
 *   XMP  (선택) - XMP 메타데이터
 *
 * 우리는 EXIF/XMP/ICCP를 떼어내고 VP8X flags를 정정한 뒤 RIFF 길이를 다시 씁니다.
 */

const TEXT = new TextDecoder('latin1');

const FOURCC = {
  RIFF: 'RIFF',
  WEBP: 'WEBP',
  VP8X: 'VP8X',
  VP8: 'VP8 ',
  VP8L: 'VP8L',
  EXIF: 'EXIF',
  XMP: 'XMP ',
  ICCP: 'ICCP',
  ALPH: 'ALPH',
  ANIM: 'ANIM',
  ANMF: 'ANMF',
} as const;

// VP8X flag 비트 (RFC 6386, 페이로드 첫 바이트)
//   bit 0 (0x01) - reserved
//   bit 1 (0x02) - animation
//   bit 2 (0x04) - XMP
//   bit 3 (0x08) - EXIF
//   bit 4 (0x10) - alpha
//   bit 5 (0x20) - ICC profile
const FLAG = {
  ANIM: 0x02,
  XMP: 0x04,
  EXIF: 0x08,
  ALPHA: 0x10,
  ICCP: 0x20,
} as const;

export interface WebPChunk {
  fourcc: string;
  /** payload 시작 오프셋 (헤더 8B 다음) */
  payloadOffset: number;
  /** payload 크기 (패딩 제외) */
  size: number;
}

export interface WebPInfo {
  /** RIFF 컨테이너인지 여부 */
  isWebP: boolean;
  chunks: WebPChunk[];
  /** VP8X flags 바이트 (없으면 undefined) */
  vp8xFlags?: number;
  /** 청크별 빠른 조회 */
  getChunk(fourcc: string): WebPChunk | undefined;
}

export function parseWebP(buf: Uint8Array): WebPInfo {
  const chunks: WebPChunk[] = [];
  const result: WebPInfo = {
    isWebP: false,
    chunks,
    getChunk(fourcc) {
      return chunks.find((c) => c.fourcc === fourcc);
    },
  };
  if (buf.length < 12) return result;
  if (TEXT.decode(buf.subarray(0, 4)) !== FOURCC.RIFF) return result;
  if (TEXT.decode(buf.subarray(8, 12)) !== FOURCC.WEBP) return result;
  result.isWebP = true;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12;
  while (off + 8 <= buf.length) {
    const fourcc = TEXT.decode(buf.subarray(off, off + 4));
    const size = view.getUint32(off + 4, true);
    if (off + 8 + size > buf.length) break;
    const payloadOffset = off + 8;
    chunks.push({ fourcc, payloadOffset, size });
    if (fourcc === FOURCC.VP8X && size >= 1) {
      result.vp8xFlags = buf[payloadOffset];
    }
    // 청크 사이즈가 홀수면 1바이트 패딩
    off += 8 + size + (size & 1);
  }
  return result;
}

/**
 * 메타데이터 청크를 제거하고 VP8X flags를 정정한 새 webp 바이너리를 만듭니다.
 *
 * **기본 동작은 화이트리스트 모드**: 알려진 이미지 데이터 청크만 남기고 그 외 모두 제거.
 * NAI가 비표준 이름으로 메타데이터를 박아도 안전하게 제거됩니다.
 *
 * 색상 프로파일(ICCP)은 유지하려면 `keepIccp: true` 지정.
 */
export interface StripOptions {
  /** ICCP 청크 보존 여부 (기본 false — 색상이 약간 달라질 수 있음) */
  keepIccp?: boolean;
  // 하위 호환 — 더이상 안 쓰지만 옛 호출 깨지지 않게
  exif?: boolean;
  xmp?: boolean;
  iccp?: boolean;
}

const IMAGE_CHUNKS = new Set<string>([FOURCC.VP8X, FOURCC.VP8, FOURCC.VP8L, FOURCC.ALPH, FOURCC.ANIM, FOURCC.ANMF]);

export function stripMetadata(buf: Uint8Array, opts: StripOptions = {}): Uint8Array {
  const info = parseWebP(buf);
  if (!info.isWebP) return buf;

  const keepIccp = opts.keepIccp === true || opts.iccp === false; // 옛 옵션 호환
  const allowed = new Set(IMAGE_CHUNKS);
  if (keepIccp) allowed.add(FOURCC.ICCP);

  const keep = info.chunks.filter((c) => allowed.has(c.fourcc));

  // VP8X flags 정정 - 메타 비트 모두 끄기 (ICCP는 보존 시 유지)
  let newFlags = info.vp8xFlags;
  if (newFlags !== undefined) {
    newFlags &= ~(FLAG.EXIF | FLAG.XMP);
    if (!keepIccp) newFlags &= ~FLAG.ICCP;
  }

  // 3) 새 버퍼 크기 계산: RIFF(12B) + 청크들(헤더 8B + payload + 패딩 1?)
  let bodySize = 0;
  for (const c of keep) {
    bodySize += 8 + c.size + (c.size & 1);
  }
  const out = new Uint8Array(12 + bodySize);
  const outView = new DataView(out.buffer);

  // 4) RIFF 헤더
  out.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  outView.setUint32(4, 4 + bodySize, true); // size: WEBP(4B) + body
  out.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'

  // 5) 청크 복사 (VP8X면 flags 갱신)
  let writeOff = 12;
  for (const c of keep) {
    // FourCC (4B)
    for (let i = 0; i < 4; i++) out[writeOff + i] = c.fourcc.charCodeAt(i);
    // size (4B LE)
    outView.setUint32(writeOff + 4, c.size, true);
    // payload
    out.set(buf.subarray(c.payloadOffset, c.payloadOffset + c.size), writeOff + 8);
    if (c.fourcc === FOURCC.VP8X && newFlags !== undefined) {
      out[writeOff + 8] = newFlags & 0xff;
    }
    writeOff += 8 + c.size + (c.size & 1);
  }
  return out;
}

export const __testing = { FOURCC, FLAG };
