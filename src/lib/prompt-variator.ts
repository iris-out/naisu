/**
 * 새 변주 모델: 고정 프롬프트 + 변경 프롬프트 프리셋.
 * - 고정 프롬프트는 그대로
 * - 매 장마다 프리셋 중 하나가 뒤에 붙음
 * - mode: sequential (1→2→…→N→1) / random (매번 추첨)
 */

import type { BatchTemplate, PromptPreset, VariationMode } from './storage';

export interface ExpandedItem {
  /** 0부터 시작하는 인덱스 */
  idx: number;
  /** 합쳐진 최종 프롬프트 */
  prompt: string;
  /** 사용된 프리셋 */
  preset: PromptPreset;
  /** 회차 (0,1,2…) — sequential일 때만 의미 있음 */
  round?: number;
}

export function totalCount(t: BatchTemplate): number {
  // 프리셋 미사용(스위치 OFF) 또는 비어있으면 = "고정 프롬프트만 N장" 모드
  if (!t.usePresets || t.presets.length === 0) return Math.max(1, t.repeats);
  return t.presets.length * Math.max(1, t.repeats);
}

/**
 * 변주를 전개합니다.
 * @param override - 총 장수를 강제 지정 (UI에서 "몇 장 만들까요?" 입력값).
 *                   생략 시 totalCount(t) 사용.
 */
const EMPTY_PRESET: PromptPreset = { id: '_empty', text: '' };

export function* expand(
  t: BatchTemplate,
  rng: () => number = Math.random,
  override?: number,
): Generator<ExpandedItem> {
  const total = override !== undefined ? Math.max(0, Math.floor(override)) : totalCount(t);
  if (total === 0) return;
  const hasPresets = t.usePresets && t.presets.length > 0;
  for (let i = 0; i < total; i++) {
    if (hasPresets) {
      const preset = pickPreset(t.presets, t.mode, i, rng);
      yield {
        idx: i,
        prompt: composePrompt(t.fixedPrompt, preset.text),
        preset,
        round: t.mode === 'sequential' ? Math.floor(i / t.presets.length) : undefined,
      };
    } else {
      // 프리셋 없음 — 고정 프롬프트만 N장 (시드만 달라지는 경우)
      yield { idx: i, prompt: t.fixedPrompt, preset: EMPTY_PRESET };
    }
  }
}

export function pickPreset(
  presets: PromptPreset[],
  mode: VariationMode,
  idx: number,
  rng: () => number,
): PromptPreset {
  if (presets.length === 0) throw new Error('빈 프리셋');
  if (mode === 'sequential') return presets[idx % presets.length]!;
  return presets[Math.floor(rng() * presets.length)]!;
}

/** 고정 + 변경 합치기. 빈 변경 프리셋이면 고정만, 둘 다 있으면 ", "로 join. */
export function composePrompt(fixed: string, change: string): string {
  const f = fixed.trim();
  const c = change.trim();
  if (!c) return f;
  if (!f) return c;
  return `${f}, ${c}`;
}

/** 미리보기용 N개만 (제너레이터를 즉시 소비). */
export function preview(t: BatchTemplate, n = 8): ExpandedItem[] {
  const out: ExpandedItem[] = [];
  let count = 0;
  for (const item of expand(t)) {
    out.push(item);
    if (++count >= n) break;
  }
  return out;
}
