/**
 * 메타데이터 되쓰기 테스트 — 전부 바이트 단위 조립/검증이라 합성 픽스처로 충분하다.
 * (webp-riff.test.ts와 같은 방침: 실제 NAI 파일이나 개인 데이터에 의존하지 않는다)
 */

import { describe, it, expect } from 'vitest';
import {
  buildExifImageDescription,
  writeJpegComment,
  writeWebpExif,
  writeCredit,
} from '../src/lib/metadata-write';
import { parseWebP } from '../src/lib/webp-riff';

const latin1 = new TextDecoder('latin1');

function u32le(bytes: Uint8Array, off: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(off, true);
}

/** VP8L 하나만 가진 최소 WebP — 캔버스가 만드는 단순 파일과 같은 모양 */
function minimalWebp(payloadSize = 12): Uint8Array {
  const body = 8 + payloadSize + (payloadSize & 1);
  const out = new Uint8Array(12 + body);
  out.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  out.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  out.set([...'VP8L'].map((c) => c.charCodeAt(0)), 12);
  new DataView(out.buffer).setUint32(16, payloadSize, true);
  return out;
}

/** SOI + APP0(JFIF 흉내) + EOI */
function minimalJpeg(): Uint8Array {
  const app0Len = 16;
  const out = new Uint8Array(2 + 2 + app0Len + 2);
  out[0] = 0xff;
  out[1] = 0xd8; // SOI
  out[2] = 0xff;
  out[3] = 0xe0; // APP0
  out[4] = (app0Len >> 8) & 0xff;
  out[5] = app0Len & 0xff;
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9; // EOI
  return out;
}

describe('buildExifImageDescription', () => {
  it('II 리틀엔디언 TIFF 헤더로 시작한다', () => {
    const t = buildExifImageDescription('hello');
    expect(latin1.decode(t.subarray(0, 2))).toBe('II');
    expect(new DataView(t.buffer).getUint16(2, true)).toBe(0x002a);
    expect(u32le(t, 4)).toBe(8); // IFD0 오프셋
  });

  it('ImageDescription(0x010E) ASCII 엔트리 하나만 담는다', () => {
    const t = buildExifImageDescription('art by me');
    const view = new DataView(t.buffer);
    expect(view.getUint16(8, true)).toBe(1); // 엔트리 개수
    expect(view.getUint16(10, true)).toBe(0x010e); // 태그
    expect(view.getUint16(12, true)).toBe(2); // type = ASCII
    expect(view.getUint32(14, true)).toBe('art by me'.length + 1); // NUL 포함
    expect(view.getUint32(26 - 4, true)).toBe(0); // 다음 IFD 없음
  });

  it('긴 문자열은 데이터 영역에 두고 오프셋으로 가리킨다', () => {
    const text = 'x'.repeat(40);
    const t = buildExifImageDescription(text);
    const off = new DataView(t.buffer).getUint32(18, true);
    expect(off).toBe(26);
    expect(latin1.decode(t.subarray(off, off + text.length))).toBe(text);
    expect(t[off + text.length]).toBe(0); // NUL 종단
  });

  it('4바이트 이하 문자열은 엔트리 안에 인라인으로 넣는다', () => {
    const t = buildExifImageDescription('ab'); // "ab\0" = 3바이트
    expect(t.length).toBe(26); // 데이터 영역이 없다
    expect(latin1.decode(t.subarray(18, 20))).toBe('ab');
  });
});

describe('writeJpegComment', () => {
  it('APP0 뒤에 COM 세그먼트를 끼워 넣는다', () => {
    const out = writeJpegComment(minimalJpeg(), 'hi');
    expect(out.status).toBe('ok');
    // SOI(2) + APP0(2+16) = 20 위치에 COM이 와야 한다
    expect(out.data[20]).toBe(0xff);
    expect(out.data[21]).toBe(0xfe);
    expect((out.data[22]! << 8) | out.data[23]!).toBe(2 + 2); // 길이 = 본문 2 + 2
    expect(latin1.decode(out.data.subarray(24, 26))).toBe('hi');
  });

  it('원본 바이트를 잃지 않는다', () => {
    const src = minimalJpeg();
    const out = writeJpegComment(src, 'tag');
    expect(out.data.length).toBe(src.length + 4 + 3);
    // EOI가 끝에 그대로 남아 있어야 한다
    expect(out.data[out.data.length - 2]).toBe(0xff);
    expect(out.data[out.data.length - 1]).toBe(0xd9);
  });

  it('JPEG가 아니면 unsupported를 돌려주고 원본을 그대로 둔다', () => {
    const src = minimalWebp();
    const out = writeJpegComment(src, 'x');
    expect(out.status).toBe('unsupported');
    expect(out.data).toBe(src);
  });

  it('65533바이트를 넘는 본문은 too-long으로 거절한다 (조용히 자르지 않는다)', () => {
    const out = writeJpegComment(minimalJpeg(), 'a'.repeat(70_000));
    expect(out.status).toBe('too-long');
  });
});

describe('writeWebpExif', () => {
  it('VP8X가 없으면 만들어서 맨 앞에 넣고 EXIF 비트를 켠다', () => {
    const out = writeWebpExif(minimalWebp(), 'credit', 832, 1216);
    expect(out.status).toBe('ok');
    const info = parseWebP(out.data);
    expect(info.isWebP).toBe(true);
    expect(info.chunks[0]!.fourcc).toBe('VP8X');
    expect(info.vp8xFlags! & 0x08).toBe(0x08);
    expect(info.getChunk('EXIF')).toBeDefined();
    expect(info.getChunk('VP8L')).toBeDefined();
  });

  it('VP8X 안에 캔버스 크기를 (값-1) 24비트 LE로 적는다', () => {
    const out = writeWebpExif(minimalWebp(), 'c', 832, 1216);
    const info = parseWebP(out.data);
    const p = info.getChunk('VP8X')!.payloadOffset;
    const read24 = (at: number): number => out.data[at]! | (out.data[at + 1]! << 8) | (out.data[at + 2]! << 16);
    expect(read24(p + 4) + 1).toBe(832);
    expect(read24(p + 7) + 1).toBe(1216);
  });

  it('RIFF 크기 필드를 새 길이에 맞게 다시 쓴다', () => {
    const out = writeWebpExif(minimalWebp(), 'credit', 100, 100);
    expect(u32le(out.data, 4)).toBe(out.data.length - 8);
  });

  it('EXIF 청크가 이미 있으면 교체한다 (두 개가 남지 않는다)', () => {
    const once = writeWebpExif(minimalWebp(), '첫 번째', 100, 100);
    const twice = writeWebpExif(once.data, '두 번째', 100, 100);
    const chunks = parseWebP(twice.data).chunks.filter((c) => c.fourcc === 'EXIF');
    expect(chunks).toHaveLength(1);
    const payload = twice.data.subarray(chunks[0]!.payloadOffset, chunks[0]!.payloadOffset + chunks[0]!.size);
    expect(new TextDecoder().decode(payload)).toContain('두 번째');
  });

  it('WebP가 아니면 unsupported', () => {
    const out = writeWebpExif(minimalJpeg(), 'x', 10, 10);
    expect(out.status).toBe('unsupported');
  });

  it('한글 크레딧도 UTF-8로 그대로 실린다', () => {
    const out = writeWebpExif(minimalWebp(), '그림: 리버문', 100, 100);
    const c = parseWebP(out.data).getChunk('EXIF')!;
    const payload = out.data.subarray(c.payloadOffset, c.payloadOffset + c.size);
    expect(new TextDecoder().decode(payload)).toContain('그림: 리버문');
  });
});

describe('writeCredit', () => {
  it('빈 문자열이면 아무것도 하지 않는다', () => {
    const src = minimalWebp();
    const out = writeCredit(src, 'webp', '   ', 10, 10);
    expect(out.status).toBe('ok');
    expect(out.data).toBe(src);
  });

  it('확장자에 맞는 경로를 고른다', () => {
    expect(writeCredit(minimalJpeg(), 'jpg', 'x', 10, 10).status).toBe('ok');
    expect(writeCredit(minimalWebp(), 'webp', 'x', 10, 10).status).toBe('ok');
    // 엇갈리면 unsupported — 확장자와 실제 내용이 어긋난 상태를 조용히 넘기지 않는다
    expect(writeCredit(minimalWebp(), 'jpg', 'x', 10, 10).status).toBe('unsupported');
  });
});
