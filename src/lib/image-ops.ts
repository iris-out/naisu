/**
 * 저장 직전 이미지 후처리 — 워터마크 · 포맷/품질.
 *
 * 전부 OffscreenCanvas 한 번 그리기로 끝난다. 하드클린이 이미 캔버스 재인코딩을
 * 하고 있어서(`service-worker.ts::hardCleanReencode`) 파이프라인은 원래 깔려 있었고,
 * 여기서는 그 한 번의 그리기에 워터마크를 얹는 것뿐이다 —
 * **하드클린 + 후처리를 두 번 인코딩하지 않기 위해** 캔버스 작업을 이 모듈 하나로 모았다.
 *
 * ⚠ 실행 컨텍스트: service worker 전용. content script에서 부르지 말 것
 *   (원본 바이트는 content가 들고 있지만, 재인코딩은 항상 저장 직전 SW에서 한다 —
 *    CLAUDE.md의 "제거는 SW에서만" 규칙과 같은 이유로 후처리도 저장 지점에 붙인다).
 */

import type { ImageOps } from './storage';

/** 워터마크가 붙는 모서리별 정렬 + 여백 계산 */
function watermarkAnchor(
  pos: ImageOps['watermark']['position'],
  cw: number,
  ch: number,
  margin: number,
): { x: number; y: number; align: CanvasTextAlign; baseline: CanvasTextBaseline } {
  const left = pos === 'tl' || pos === 'bl';
  const top = pos === 'tl' || pos === 'tr';
  return {
    x: left ? margin : cw - margin,
    y: top ? margin : ch - margin,
    align: left ? 'left' : 'right',
    baseline: top ? 'top' : 'bottom',
  };
}

export interface RenderOptions {
  /**
   * 알파 채널을 없애고 이 색으로 합성한다(JPEG 출력 시 필수 — 투명 영역이 검게 뭉개지는 걸 방지).
   * null이면 투명도를 유지한다.
   */
  flattenTo: string | null;
  /**
   * 워터마크에 쓸 font-family 이름. 커스텀 폰트를 성공적으로 불러왔을 때만 호출부가
   * 넘긴다(FontFace 등록은 이 함수의 책임이 아니다 — service-worker.ts가 renderProcessed를
   * 부르기 전에 lib/webfont.ts로 미리 등록해 둔다). 없으면 기본 sans-serif.
   */
  watermarkFontFamily?: string;
}

/**
 * 비트맵을 후처리해서 캔버스로 돌려준다. 원본 크기 그대로 그리고 워터마크만 얹는다.
 * 인코딩은 하지 않는다(호출부가 포맷을 정한다). 비트맵은 이 함수가 닫지 않는다 —
 * 호출부가 소유권을 갖는다.
 */
export function renderProcessed(
  bitmap: ImageBitmap,
  ops: ImageOps,
  renderOpts: RenderOptions,
): OffscreenCanvas {
  const cw = bitmap.width;
  const ch = bitmap.height;
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d')!;

  // JPEG로 나갈 것이면 항상 불투명하게 깐다(alpha 채널 제거).
  if (renderOpts.flattenTo) {
    ctx.fillStyle = renderOpts.flattenTo;
    ctx.fillRect(0, 0, cw, ch);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0);

  const wm = ops.watermark;
  if (wm.on && wm.text.trim()) {
    const size = Math.max(10, Math.round((Math.min(cw, ch) * wm.scalePct) / 100));
    const margin = Math.round(size * 0.75);
    const a = watermarkAnchor(wm.position, cw, ch, margin);
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, wm.opacity));
    const fontFamily = renderOpts.watermarkFontFamily ?? 'sans-serif';
    ctx.font = `600 ${size}px "${fontFamily}"`;
    ctx.textAlign = a.align;
    ctx.textBaseline = a.baseline;
    // 밝은 배경에서도 어두운 배경에서도 읽히도록 검은 외곽선 + 글자색
    ctx.lineWidth = Math.max(1, size * 0.14);
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.lineJoin = 'round';
    ctx.strokeText(wm.text, a.x, a.y);
    ctx.fillStyle = wm.color || '#ffffff';
    ctx.fillText(wm.text, a.x, a.y);
    ctx.restore();
  }

  return canvas;
}

/** 캔버스를 지정한 포맷·품질로 인코딩한다. */
export async function encodeImage(
  canvas: OffscreenCanvas,
  type: 'image/jpeg' | 'image/webp',
  quality: number,
): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** 설정 요약 — 로그/패널에 "무엇이 적용됐는지" 한 줄로 보여주기 위한 것. */
export function opsSummary(ops: ImageOps): string {
  const bits: string[] = [];
  // 'jpg'는 확장자이고 사람이 읽는 이름은 JPEG다 — 요약은 사용자가 쓰는 말로.
  if (ops.format !== 'auto') bits.push(ops.format === 'jpg' ? 'JPEG' : 'WebP');
  if (ops.watermark.on && ops.watermark.text.trim()) bits.push('워터마크');
  if (ops.credit.on && ops.credit.text.trim()) bits.push('크레딧');
  return bits.join(' · ');
}
