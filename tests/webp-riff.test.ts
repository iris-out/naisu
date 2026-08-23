/**
 * 실제 NAI 이미지(개인 프롬프트 데이터 포함)에 대한 외부 파일 의존을 피하려고,
 * RIFF/WebP 청크 구조를 손으로 조립한 합성(synthetic) 픽스처로 테스트한다.
 * parseWebP/stripMetadata는 청크 헤더·바이트 단위로만 동작하므로(EXIF 내부의 실제
 * TIFF 구조까지는 몰라도 됨 — CLAUDE.md의 "청크 단위 화이트리스트" 설계 참고) 실제
 * 유효한 VP8L 비트스트림이나 TIFF IFD가 없어도 충분히 의미 있는 검증이 된다.
 */
import { describe, it, expect } from 'vitest';
import { parseWebP, stripMetadata } from '../src/lib/webp-riff';

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function chunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const pad = payload.length % 2 === 1 ? new Uint8Array([0]) : new Uint8Array(0);
  return concatBytes(ascii(fourcc), u32le(payload.length), payload, pad);
}

const NEEDLE = 'NovelAI Diffusion';

/** VP8X(EXIF+ALPHA+ICCP 플래그) + 더미 VP8L(홀수 길이 — 패딩 처리 검증용) + EXIF + ICCP 청크로 구성된 합성 webp. */
function buildSyntheticWebp(): Uint8Array {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x08 | 0x10 | 0x20; // EXIF | ALPHA | ICCP
  const w1 = 3; // width-1 (4px)
  const h1 = 3; // height-1 (4px)
  vp8x[4] = w1 & 0xff;
  vp8x[7] = h1 & 0xff;

  const vp8lPayload = new Uint8Array([0x2f, 0x00, 0x00, 0x00, 0xaa, 0xbb, 0xcc]); // 홀수 길이 — 패딩 1B 필요
  const exifPayload = ascii(`FAKE_TIFF::Software=${NEEDLE} V5 TESTHASH::prompt=synthetic test prompt::end`);
  const iccpPayload = ascii('FAKE_ICC_PROFILE');

  const body = concatBytes(
    chunk('VP8X', vp8x),
    chunk('VP8L', vp8lPayload),
    chunk('ICCP', iccpPayload),
    chunk('EXIF', exifPayload),
  );
  return concatBytes(ascii('RIFF'), u32le(4 + body.length), ascii('WEBP'), body);
}

describe('parseWebP', () => {
  it('합성 RIFF 청크 구조(VP8X/VP8L/ICCP/EXIF)를 정확히 인식한다', () => {
    const info = parseWebP(buildSyntheticWebp());
    expect(info.isWebP).toBe(true);
    expect(info.truncated).toBe(false);
    expect(info.chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'VP8L', 'ICCP', 'EXIF']);
    expect(info.vp8xFlags).toBe(0x38); // EXIF(0x08) + ALPHA(0x10) + ICCP(0x20)
    expect(info.getChunk('EXIF')?.size).toBeGreaterThan(0);
  });

  it('청크 크기 필드가 버퍼 범위를 넘으면 truncated=true를 세팅하고 그 이후 청크를 버린다', () => {
    const buf = buildSyntheticWebp();
    const exif = parseWebP(buf).getChunk('EXIF')!;
    const corrupted = buf.slice();
    const view = new DataView(corrupted.buffer);
    view.setUint32(exif.payloadOffset - 4, 0xffffff, true); // EXIF 크기 필드를 터무니없이 크게 조작

    const info = parseWebP(corrupted);
    expect(info.truncated).toBe(true);
    expect(info.getChunk('EXIF')).toBeUndefined();
  });
});

describe('stripMetadata', () => {
  it('EXIF/ICCP를 제거하고 VP8X flags의 EXIF·ICCP 비트만 끈다(ALPHA는 유지)', () => {
    const cleaned = stripMetadata(buildSyntheticWebp());
    const info = parseWebP(cleaned);

    expect(info.getChunk('EXIF')).toBeUndefined();
    expect(info.getChunk('ICCP')).toBeUndefined();
    expect(info.vp8xFlags).toBe(0x10); // ALPHA만 남음
  });

  it('픽셀 데이터(VP8L, 홀수 길이 청크)는 패딩 포함 바이트 단위로 완전히 보존한다', () => {
    const buf = buildSyntheticWebp();
    const cleaned = stripMetadata(buf);
    const before = parseWebP(buf).getChunk('VP8L')!;
    const after = parseWebP(cleaned).getChunk('VP8L')!;

    expect(after.size).toBe(before.size);
    expect(cleaned.subarray(after.payloadOffset, after.payloadOffset + after.size)).toEqual(
      buf.subarray(before.payloadOffset, before.payloadOffset + before.size),
    );
  });

  it('EXIF 안에 박혀있던 문자열이 결과물에서 실제로 사라진다', () => {
    const buf = buildSyntheticWebp();
    const needle = ascii(NEEDLE);
    const indexOf = (hay: Uint8Array): number => {
      outer: for (let i = 0; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return i;
      }
      return -1;
    };
    expect(indexOf(buf)).toBeGreaterThan(-1); // 사전 조건: 원본에는 있어야 함

    const cleaned = stripMetadata(buf);
    expect(indexOf(cleaned)).toBe(-1);
  });

  it('keepIccp:true면 ICCP는 보존하고 EXIF는 여전히 제거한다', () => {
    const cleaned = stripMetadata(buildSyntheticWebp(), { keepIccp: true });
    const info = parseWebP(cleaned);

    expect(info.getChunk('EXIF')).toBeUndefined();
    expect(info.getChunk('ICCP')).toBeDefined();
    expect(info.vp8xFlags).toBe(0x30); // ALPHA + ICCP만 남음
  });
});
