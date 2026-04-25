import { parseWebP } from './webp-riff';
import type { NaiGenerationParams, NaiMetadata } from './types';

/**
 * WebP에서 EXIF 청크를 꺼내고, 그 안에서 NAI 생성 파라미터(JSON-in-JSON)를 풀어냅니다.
 */

const TIFF_LE = 0x4949; // 'II' little-endian
const TIFF_BE = 0x4d4d; // 'MM' big-endian

const TAG = {
  ImageDescription: 0x010e,
  Software: 0x0131,
  ExifIFDPointer: 0x8769,
  UserComment: 0x9286,
} as const;

const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** TIFF 헤더 시작점 기준 절대 오프셋. 4B 안에 들어가면 inline */
  valueOffset: number;
  /** entry 의 4-byte value 슬롯 (필요시 inline 해석에 사용) */
  rawValueBytes: Uint8Array;
}

function readIFD(view: DataView, base: number, ifdOffset: number, le: boolean): IfdEntry[] {
  const entries: IfdEntry[] = [];
  const count = view.getUint16(base + ifdOffset, le);
  for (let i = 0; i < count; i++) {
    const off = base + ifdOffset + 2 + i * 12;
    const tag = view.getUint16(off, le);
    const type = view.getUint16(off + 2, le);
    const cnt = view.getUint32(off + 4, le);
    const valueOffsetField = view.getUint32(off + 8, le);
    const tSize = TYPE_SIZE[type] ?? 1;
    const total = tSize * cnt;
    const valueAbs = total <= 4 ? off + 8 - base : valueOffsetField;
    const rawValueBytes = new Uint8Array(view.buffer, view.byteOffset + off + 8, 4);
    entries.push({ tag, type, count: cnt, valueOffset: valueAbs, rawValueBytes });
  }
  return entries;
}

function readAscii(buf: Uint8Array, _view: DataView, base: number, e: IfdEntry): string {
  const start = base + e.valueOffset;
  const end = start + e.count;
  if (end > buf.length) return '';
  // null 종단 제거
  let stop = end;
  while (stop > start && buf[stop - 1] === 0) stop--;
  return new TextDecoder('utf-8').decode(buf.subarray(start, stop));
}

function readUndefined(buf: Uint8Array, base: number, e: IfdEntry): Uint8Array {
  const start = base + e.valueOffset;
  return buf.subarray(start, start + e.count);
}

function decodeUserComment(bytes: Uint8Array): string {
  // EXIF UserComment: 첫 8바이트는 charset 코드 (ASCII\0\0\0, JIS, UNICODE, UNDEFINED)
  if (bytes.length < 8) return '';
  const charset = new TextDecoder('latin1').decode(bytes.subarray(0, 8)).replace(/\0+$/, '').trim();
  const body = bytes.subarray(8);
  switch (charset) {
    case 'UNICODE':
      // EXIF UNICODE는 UTF-16. byte order는 EXIF 자체 endian을 따름. 보통 BOM 없음.
      // NAI는 ASCII 경로를 쓰므로 일단 UTF-16LE 기본으로.
      return new TextDecoder('utf-16le').decode(body);
    case 'JIS':
      return new TextDecoder('iso-2022-jp').decode(body);
    case 'ASCII':
    default:
      // NAI는 'ASCII' prefix를 쓰지만 본문은 UTF-8 JSON
      return new TextDecoder('utf-8').decode(body);
  }
}

/**
 * EXIF 바이너리(TIFF 헤더로 시작하는 블록)에서 NAI 메타데이터를 뽑아냅니다.
 */
export function parseExifBlock(exif: Uint8Array): NaiMetadata {
  const meta: NaiMetadata = { raw: {} };
  if (exif.length < 8) return meta;
  const view = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);

  const byteOrder = view.getUint16(0, false);
  let le: boolean;
  if (byteOrder === TIFF_LE) le = true;
  else if (byteOrder === TIFF_BE) le = false;
  else return meta;

  // 0x002A 매직 넘버 확인
  const magic = view.getUint16(2, le);
  if (magic !== 0x002a) return meta;

  const ifd0Off = view.getUint32(4, le);
  const ifd0 = readIFD(view, 0, ifd0Off, le);

  let userComment: Uint8Array | undefined;

  for (const e of ifd0) {
    switch (e.tag) {
      case TAG.Software:
        meta.software = readAscii(exif, view, 0, e);
        break;
      case TAG.ImageDescription:
        meta.description = readAscii(exif, view, 0, e);
        break;
      case TAG.ExifIFDPointer: {
        // SubIFD를 따라가서 UserComment 찾기
        const subOff =
          e.type === 4 && e.count === 1
            ? new DataView(e.rawValueBytes.buffer, e.rawValueBytes.byteOffset, 4).getUint32(0, le)
            : e.valueOffset;
        const sub = readIFD(view, 0, subOff, le);
        for (const se of sub) {
          if (se.tag === TAG.UserComment && se.type === 7) {
            userComment = readUndefined(exif, 0, se);
          } else if (se.tag === TAG.Software && !meta.software) {
            meta.software = readAscii(exif, view, 0, se);
          }
        }
        break;
      }
    }
  }

  if (userComment) {
    const text = decodeUserComment(userComment);
    meta.raw!.userComment = text;
    // NAI 형식: { "Comment": "<inner JSON>" }
    try {
      const outer = JSON.parse(text);
      const inner = typeof outer === 'object' && outer !== null && 'Comment' in outer
        ? (outer as { Comment: string }).Comment
        : null;
      if (typeof inner === 'string') {
        meta.raw!.comment = inner;
        try {
          meta.generation = JSON.parse(inner) as NaiGenerationParams;
        } catch {
          /* inner 파싱 실패 - raw만 보관 */
        }
      } else if (typeof outer === 'object' && outer !== null && 'prompt' in outer) {
        // 혹시 NAI가 outer 자체에 prompt를 둔 경우
        meta.generation = outer as NaiGenerationParams;
      }
    } catch {
      /* outer JSON 아님 - raw만 보관 */
    }
  }

  return meta;
}

/**
 * WebP 바이너리에서 NAI 메타데이터를 추출합니다.
 */
export function parseNaiWebP(buf: Uint8Array): NaiMetadata {
  const info = parseWebP(buf);
  if (!info.isWebP) return {};
  const exif = info.getChunk('EXIF');
  if (!exif) return {};
  const slice = buf.subarray(exif.payloadOffset, exif.payloadOffset + exif.size);
  return parseExifBlock(slice);
}

/**
 * NAI 메타데이터를 사람이 읽기 좋은 평탄한 객체로.
 */
export function summarize(meta: NaiMetadata) {
  const g = meta.generation;
  return {
    software: meta.software,
    description: meta.description,
    model: meta.software,
    prompt: g?.prompt ?? meta.description,
    uc: g?.v4_negative_prompt?.caption?.base_caption,
    seed: g?.seed,
    steps: g?.steps,
    sampler: typeof g?.sampler === 'string' ? g.sampler : undefined,
    scale: g?.scale,
    uncondScale: g?.uncond_scale,
    cfgRescale: g?.cfg_rescale,
    noise: g?.noise_schedule,
    width: g?.width,
    height: g?.height,
    nSamples: g?.n_samples,
    characters: g?.v4_prompt?.caption?.char_captions ?? [],
  };
}
