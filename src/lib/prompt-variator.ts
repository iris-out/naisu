/**
 * 새 변주 모델: 고정 프롬프트 + 변경 프롬프트 프리셋.
 * - 고정 프롬프트는 그대로
 * - 매 장마다 프리셋 중 하나가 뒤에 붙음
 * - mode: sequential (1→2→…→N→1) / random (매번 추첨)
 *
 * N05. 인라인 랜덤 치환 문법 — `{a|b|c}`
 * 고정 프롬프트 / 프리셋 텍스트 어느 쪽에 써도 매 장마다 셋 중 하나가 뽑힌다.
 * 자세한 문법·이스케이프 규칙은 resolveInlineRandom() 주석 참고.
 */

import type { BatchTemplate, PromptPreset, VariationMode } from './storage';

export interface ExpandedItem {
  /** 0부터 시작하는 인덱스 */
  idx: number;
  /** 합쳐진 최종 프롬프트 (인라인 랜덤까지 전개된 결과) */
  prompt: string;
  /** 사용된 프리셋 (원본 — 인라인 랜덤 치환 전 텍스트를 담고 있음) */
  preset: PromptPreset;
  /** 회차 (0,1,2…) — sequential일 때만 의미 있음 */
  round?: number;
  /**
   * 고정 프롬프트 부분의 전개 결과 (인라인 랜덤 치환은 적용됨, 프리셋과는 아직 합쳐지지 않음).
   * 미리보기 UI가 "고정 vs 변형"을 시각적으로 구분할 수 있도록 U01에서 추가.
   */
  fixedResolved: string;
  /**
   * 프리셋(변형) 부분의 전개 결과 (인라인 랜덤 치환 적용됨). 프리셋 미사용 모드면 빈 문자열.
   */
  presetResolved: string;
}

export function totalCount(t: BatchTemplate): number {
  // 프리셋 미사용(스위치 OFF) 또는 비어있으면 = "고정 프롬프트만 N장" 모드
  // (인라인 랜덤은 매 장의 "내용"만 바꿀 뿐 장수에는 영향을 주지 않는다)
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
      // 인라인 랜덤은 고정/프리셋 각각에 대해 매 장마다 독립적으로 다시 뽑힌다.
      const fixedResolved = resolveInlineRandom(t.fixedPrompt, rng);
      const presetResolved = resolveInlineRandom(preset.text, rng);
      yield {
        idx: i,
        prompt: composePrompt(fixedResolved, presetResolved),
        preset,
        round: t.mode === 'sequential' ? Math.floor(i / t.presets.length) : undefined,
        fixedResolved,
        presetResolved,
      };
    } else {
      // 프리셋 없음 — 고정 프롬프트만 N장 (시드만 달라지는 경우)
      const fixedResolved = resolveInlineRandom(t.fixedPrompt, rng);
      yield { idx: i, prompt: fixedResolved, preset: EMPTY_PRESET, fixedResolved, presetResolved: '' };
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

// ---------------------------------------------------------------------------
// N05. 인라인 랜덤 치환 — `{a|b|c}`
// ---------------------------------------------------------------------------

type InlineNode = { type: 'text'; value: string } | { type: 'choice'; options: InlineNode[][] };

/** 이스케이프 가능한 문자 — 이 넷만 `\` 뒤에 오면 리터럴로 취급된다. */
const ESCAPABLE = '{}|\\';

interface SeqResult {
  nodes: InlineNode[];
  end: number;
  ok: boolean;
}

interface AltResult {
  options: InlineNode[][];
  end: number;
  ok: boolean;
}

/**
 * `start`부터 시작해 하나의 대안(`|`으로 갈라지지 않는 연속 구간)을 파싱한다.
 * `insideBraces`가 true면(=`{`,`}` 안쪽) `|`와 `}`를 만나는 순간 멈추고 그 위치를 돌려준다
 * (그 문자 처리는 호출자인 parseAlt 몫). false(최상위)면 `|`,`}`는 그냥 리터럴 문자다 —
 * 중괄호 밖에서는 파이프/닫는 중괄호에 아무 문법적 의미가 없다.
 */
function parseSeq(s: string, start: number, insideBraces: boolean): SeqResult {
  const nodes: InlineNode[] = [];
  let buf = '';
  let i = start;
  const flush = () => {
    if (buf) {
      nodes.push({ type: 'text', value: buf });
      buf = '';
    }
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1]!)) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (insideBraces && (ch === '|' || ch === '}')) break;
    if (ch === '{') {
      flush();
      const inner = parseAlt(s, i + 1, true);
      if (!inner.ok) return { nodes: [], end: -1, ok: false };
      nodes.push({ type: 'choice', options: inner.options });
      i = inner.end;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return { nodes, end: i, ok: true };
}

/**
 * `|`로 구분된 대안 목록을 파싱한다. `insideBraces`면 끝에서 반드시 `}`로 닫혀야 하고,
 * 못 찾으면(문자열 끝에 도달) 짝이 안 맞는 것으로 보고 실패(ok:false)를 돌려준다 —
 * 이 실패는 최상위까지 그대로 전파되어 결국 원문을 손대지 않고 그대로 반환하게 만든다.
 */
function parseAlt(s: string, start: number, insideBraces: boolean): AltResult {
  const options: InlineNode[][] = [];
  let i = start;
  for (;;) {
    const seq = parseSeq(s, i, insideBraces);
    if (!seq.ok) return { options: [], end: -1, ok: false };
    options.push(seq.nodes);
    i = seq.end;
    if (i < s.length && s[i] === '|') {
      i++;
      continue;
    }
    break;
  }
  if (insideBraces) {
    if (i < s.length && s[i] === '}') return { options, end: i + 1, ok: true };
    return { options: [], end: -1, ok: false }; // 닫는 중괄호를 못 찾음 → 짝 안 맞음
  }
  return { options, end: i, ok: true };
}

function pickRandom<T>(arr: T[], rng: () => number): T {
  const idx = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[Math.max(0, idx)]!;
}

function renderNodes(nodes: InlineNode[], rng: () => number): string {
  let out = '';
  for (const n of nodes) {
    out += n.type === 'text' ? n.value : renderNodes(pickRandom(n.options, rng), rng);
  }
  return out;
}

/**
 * 인라인 랜덤 치환. `{a|b|c}` 중 하나를 rng()로 골라 치환한다.
 *
 * 문법
 * - `{a|b|c}` → a/b/c 중 하나 (매번 rng() 한 번 소비)
 * - 중첩 가능: `{a|{b|c}}` — 바깥을 먼저 고르고, 안쪽이 선택되면 다시 rng()로 고름
 * - 빈 선택지 허용: `{smile|}` → "smile" 또는 "" (아무것도 안 붙음)
 * - 이스케이프: `\{` `\}` `\|` `\\` 는 각각 리터럴 `{` `}` `|` `\` 로 취급되고
 *   문법(중괄호/구분자)으로 해석되지 않는다. 글자 그대로 중괄호를 쓰고 싶으면 이 규칙을 쓴다.
 * - 중괄호 밖(최상위)에서는 `|`와 `}`가 아무 의미 없는 그냥 문자다. `{`로 시작한 그룹 안에서만
 *   `|`/`}`가 구분자/종료자로 동작한다.
 * - 잘못된 입력(짝이 안 맞는 `{`, 예: `{a|b`)은 예외를 던지지 않고 **원문 문자열 전체를 그대로**
 *   반환한다 — 배치 도중 크래시보다 "치환이 한 번 안 먹힌다"가 훨씬 안전하기 때문.
 *   (부분적으로만 고쳐서 반환하지 않는 이유: 어디까지가 "의도한 그룹"인지 알 수 없어서
 *   섣불리 부분 치환하면 사용자가 원하지 않은 결과가 조용히 나갈 수 있음)
 *
 * 난수는 반드시 인자로 받은 rng()만 사용한다 — Math.random()을 직접 호출하지 않음
 * (expand()가 넘겨주는 rng를 그대로 통과시켜야 배치 실행/테스트 모두 결정적으로 재현 가능).
 */
export function resolveInlineRandom(text: string, rng: () => number): string {
  const result = parseAlt(text, 0, false);
  if (!result.ok) return text; // 짝 안 맞음 → 원문 그대로
  // 최상위는 `|`로 갈라지지 않는 단일 시퀀스이므로 options는 항상 정확히 1개.
  return renderNodes(result.options[0]!, rng);
}
