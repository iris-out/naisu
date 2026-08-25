/**
 * 후처리 설정(ImageOps) 순수 함수 테스트.
 *
 * renderProcessed/encodeImage는 OffscreenCanvas에 의존해 node 환경(vitest)에서는
 * 돌릴 수 없다. 여기서는 상태 판정·병합·요약처럼 canvas 없이 검증 가능한 순수 함수만
 * 다룬다 — CLAUDE.md의 "합성 픽스처로 순수 함수를 채우는 것이 ROI가 높다" 방침 그대로.
 */

import { describe, it, expect } from 'vitest';
import { opsSummary } from '../src/lib/image-ops';
import { DEFAULT_IMAGE_OPS, isImageOpsIdentity, mergeImageOps, type ImageOps } from '../src/lib/storage';

function ops(patch: Partial<ImageOps> = {}): ImageOps {
  return { ...DEFAULT_IMAGE_OPS, ...patch };
}

describe('isImageOpsIdentity', () => {
  it('기본값은 후처리 없음으로 본다 — 불필요한 재인코딩을 막는 판정', () => {
    expect(isImageOpsIdentity(DEFAULT_IMAGE_OPS)).toBe(true);
  });

  it('품질만 바뀐 것은 후처리로 보지 않는다 (하드클린이 원래 쓰는 값이므로)', () => {
    expect(isImageOpsIdentity(ops({ quality: 0.7 }))).toBe(true);
  });

  it.each([
    ['포맷 지정', ops({ format: 'jpg' })],
    ['워터마크', ops({ watermark: { ...DEFAULT_IMAGE_OPS.watermark, on: true } })],
    ['크레딧', ops({ credit: { on: true, text: 'x' } })],
  ])('%s가 켜지면 후처리로 본다', (_label, o) => {
    expect(isImageOpsIdentity(o)).toBe(false);
  });
});

describe('mergeImageOps', () => {
  it('부분 저장값을 완전한 값으로 채운다', () => {
    const merged = mergeImageOps({ quality: 0.7 });
    expect(merged.quality).toBe(0.7);
    expect(merged.watermark).toEqual(DEFAULT_IMAGE_OPS.watermark);
    expect(merged.credit).toEqual(DEFAULT_IMAGE_OPS.credit);
  });

  it('중첩 객체가 부분적으로만 저장돼 있어도 나머지가 살아남는다', () => {
    const merged = mergeImageOps({ watermark: { on: true } as ImageOps['watermark'] });
    expect(merged.watermark.on).toBe(true);
    expect(merged.watermark.position).toBe(DEFAULT_IMAGE_OPS.watermark.position);
    expect(merged.watermark.opacity).toBe(DEFAULT_IMAGE_OPS.watermark.opacity);
  });

  it('undefined면 기본값 사본을 돌려준다 (원본을 공유하지 않는다)', () => {
    const a = mergeImageOps(undefined);
    a.quality = 0.5;
    expect(DEFAULT_IMAGE_OPS.quality).toBe(1);
  });
});

describe('opsSummary', () => {
  it('아무것도 안 켜져 있으면 빈 문자열', () => {
    expect(opsSummary(DEFAULT_IMAGE_OPS)).toBe('');
  });

  it('켜진 것만 모아 한 줄로 만든다', () => {
    const s = opsSummary(ops({ format: 'jpg', watermark: { ...DEFAULT_IMAGE_OPS.watermark, on: true, text: '@handle' } }));
    expect(s).toContain('JPEG');
    expect(s).toContain('워터마크');
  });

  it('워터마크는 문구가 비어 있으면 세지 않는다', () => {
    const on = ops({ watermark: { ...DEFAULT_IMAGE_OPS.watermark, on: true, text: '  ' } });
    expect(opsSummary(on)).toBe('');
  });
});
