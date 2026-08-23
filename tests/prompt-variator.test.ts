/**
 * prompt-variator 순수 로직 테스트.
 * DOM/chrome API 의존 없음 — 합성 픽스처(BatchTemplate 객체를 직접 구성)만 사용.
 * 난수는 항상 결정적 스텁(makeStubRng)으로 고정해서 rng() 호출 순서/횟수까지 검증한다.
 */
import { describe, it, expect } from 'vitest';
import {
  composePrompt,
  expand,
  pickPreset,
  preview,
  resolveInlineRandom,
  totalCount,
} from '../src/lib/prompt-variator';
import type { BatchTemplate, PromptPreset } from '../src/lib/storage';

/** 미리 정해둔 값을 순서대로 뱉는 결정적 rng 스텁. 소진되면 에러(과소비 검출용). */
function makeStubRng(values: number[]): () => number {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error(`rng 스텁 소진 (요청 ${i + 1}번째, 준비된 값 ${values.length}개)`);
    return values[i++]!;
  };
}

function makePreset(text: string, id = text): PromptPreset {
  return { id, text };
}

function makeTemplate(overrides: Partial<BatchTemplate> = {}): BatchTemplate {
  return {
    id: 't1',
    name: 'template_01',
    fixedPrompt: '1girl, masterpiece',
    usePresets: true,
    presets: [makePreset('smile'), makePreset('pout'), makePreset('>_<')],
    mode: 'sequential',
    repeats: 1,
    randomSeed: true,
    uc: '',
    characterPrompts: [],
    ...overrides,
  };
}

describe('resolveInlineRandom — 인라인 랜덤 치환', () => {
  it('중괄호가 없으면 원문 그대로 반환한다 (rng 소비 없음)', () => {
    const rng = makeStubRng([]);
    expect(resolveInlineRandom('1girl, standing', rng)).toBe('1girl, standing');
  });

  it('단일 선택: rng 값에 따라 셋 중 하나를 고른다', () => {
    // floor(0 * 3) = 0 → 'smile'
    expect(resolveInlineRandom('{smile|pout|>_<}', makeStubRng([0]))).toBe('smile');
    // floor(0.4 * 3) = 1 → 'pout'
    expect(resolveInlineRandom('{smile|pout|>_<}', makeStubRng([0.4]))).toBe('pout');
    // floor(0.99 * 3) = 2 → '>_<'
    expect(resolveInlineRandom('{smile|pout|>_<}', makeStubRng([0.99]))).toBe('>_<');
  });

  it('앞뒤 고정 텍스트와 함께 한 문장 안에서 치환된다', () => {
    expect(resolveInlineRandom('1girl, {smile|pout|>_<}, standing', makeStubRng([0]))).toBe(
      '1girl, smile, standing',
    );
  });

  it('중첩 지원: 바깥 선택 후 안쪽이 뽑히면 다시 rng를 소비한다', () => {
    // 바깥: floor(0.6*2)=1 → 두 번째 대안({b|c}) 선택
    // 안쪽: floor(0.9*2)=1 → 'c'
    expect(resolveInlineRandom('{a|{b|c}}', makeStubRng([0.6, 0.9]))).toBe('c');
  });

  it('중첩: 바깥에서 첫 대안이 뽑히면 안쪽은 평가되지 않는다(rng 1회만 소비)', () => {
    const rng = makeStubRng([0]); // 바깥: floor(0*2)=0 → 'a', 안쪽 rng 호출 없음
    expect(resolveInlineRandom('{a|{b|c}}', rng)).toBe('a');
  });

  it('빈 선택지를 허용한다 — "smile" 또는 빈 문자열', () => {
    expect(resolveInlineRandom('{smile|}', makeStubRng([0]))).toBe('smile');
    expect(resolveInlineRandom('{smile|}', makeStubRng([0.9]))).toBe('');
  });

  it('이스케이프: \\{ \\} \\| \\\\ 는 리터럴로 취급되고 문법으로 해석되지 않는다', () => {
    const rng = makeStubRng([]); // 문법으로 해석 안 되므로 rng 소비 없어야 함
    expect(resolveInlineRandom('literal \\{a|b\\} braces', rng)).toBe('literal {a|b} braces');
    expect(resolveInlineRandom('a \\| b', makeStubRng([]))).toBe('a | b');
    expect(resolveInlineRandom('back\\\\slash', makeStubRng([]))).toBe('back\\slash');
  });

  it('이스케이프된 중괄호 안에서는 실제 선택 문법도 동작한다', () => {
    // \{ 로 리터럴 { 를 낸 뒤, 그 뒤에 오는 진짜 {a|b}는 여전히 문법으로 해석되어야 함
    expect(resolveInlineRandom('\\{{a|b}', makeStubRng([0]))).toBe('{a');
  });

  it('중괄호 밖의 |와 }는 문법적 의미가 없는 그냥 문자다', () => {
    const rng = makeStubRng([]);
    expect(resolveInlineRandom('a | b } c', rng)).toBe('a | b } c');
  });

  it('짝이 맞지 않는 중괄호는 예외를 던지지 않고 원문을 그대로 반환한다', () => {
    const rng = makeStubRng([]);
    expect(resolveInlineRandom('{a|b', rng)).toBe('{a|b');
    expect(resolveInlineRandom('1girl, {smile|pout, standing', rng)).toBe(
      '1girl, {smile|pout, standing',
    );
    expect(resolveInlineRandom('{a|{b|c}', rng)).toBe('{a|{b|c}'); // 안쪽만 닫히고 바깥은 안 닫힘
  });

  it('여러 그룹이 한 문장에 있으면 그룹마다 독립적으로 rng를 소비한다', () => {
    // 첫 그룹: floor(0*2)=0 → 'red', 둘째 그룹: floor(0.9*2)=1 → 'short'
    expect(
      resolveInlineRandom('{red|blue} hair, {long|short} skirt', makeStubRng([0, 0.9])),
    ).toBe('red hair, short skirt');
  });
});

describe('pickPreset', () => {
  const presets = [makePreset('a'), makePreset('b'), makePreset('c')];

  it('sequential 모드는 인덱스를 프리셋 개수로 순환한다', () => {
    expect(pickPreset(presets, 'sequential', 0, makeStubRng([]))).toEqual(presets[0]);
    expect(pickPreset(presets, 'sequential', 1, makeStubRng([]))).toEqual(presets[1]);
    expect(pickPreset(presets, 'sequential', 2, makeStubRng([]))).toEqual(presets[2]);
    expect(pickPreset(presets, 'sequential', 3, makeStubRng([]))).toEqual(presets[0]); // 순환
    expect(pickPreset(presets, 'sequential', 4, makeStubRng([]))).toEqual(presets[1]);
  });

  it('random 모드는 rng를 사용해 고른다', () => {
    expect(pickPreset(presets, 'random', 0, makeStubRng([0]))).toEqual(presets[0]);
    expect(pickPreset(presets, 'random', 0, makeStubRng([0.5]))).toEqual(presets[1]);
    expect(pickPreset(presets, 'random', 0, makeStubRng([0.9]))).toEqual(presets[2]);
  });

  it('빈 프리셋 배열이면 예외를 던진다', () => {
    expect(() => pickPreset([], 'sequential', 0, makeStubRng([]))).toThrow();
  });
});

describe('composePrompt', () => {
  it('둘 다 있으면 ", "로 합친다', () => {
    expect(composePrompt('1girl', 'smile')).toBe('1girl, smile');
  });

  it('변경 텍스트가 빈 문자열이면 고정만 반환한다', () => {
    expect(composePrompt('1girl', '')).toBe('1girl');
    expect(composePrompt('1girl', '   ')).toBe('1girl');
  });

  it('고정이 빈 문자열이면 변경만 반환한다', () => {
    expect(composePrompt('', 'smile')).toBe('smile');
    expect(composePrompt('   ', 'smile')).toBe('smile');
  });

  it('둘 다 비어있으면 빈 문자열', () => {
    expect(composePrompt('', '')).toBe('');
    expect(composePrompt('  ', '  ')).toBe('');
  });

  it('앞뒤 공백은 trim된다', () => {
    expect(composePrompt('  1girl  ', '  smile  ')).toBe('1girl, smile');
  });
});

describe('totalCount', () => {
  it('usePresets=false면 repeats장 (프리셋 무시)', () => {
    expect(totalCount(makeTemplate({ usePresets: false, repeats: 5 }))).toBe(5);
  });

  it('presets가 비어있으면 프리셋을 켰어도 repeats장', () => {
    expect(totalCount(makeTemplate({ usePresets: true, presets: [], repeats: 4 }))).toBe(4);
  });

  it('presets 있으면 presets.length * repeats', () => {
    expect(
      totalCount(
        makeTemplate({ usePresets: true, presets: [makePreset('a'), makePreset('b')], repeats: 3 }),
      ),
    ).toBe(6);
  });

  it('repeats가 0 이하여도 최소 1로 취급된다', () => {
    expect(totalCount(makeTemplate({ usePresets: false, repeats: 0 }))).toBe(1);
  });

  it('인라인 랜덤 문법이 있어도 장수에는 영향을 주지 않는다', () => {
    const withInline = makeTemplate({
      usePresets: true,
      fixedPrompt: '{a|b|c}, {x|y}',
      presets: [makePreset('{p1|p2|p3|p4}'), makePreset('q')],
      repeats: 3,
    });
    const without = makeTemplate({
      usePresets: true,
      fixedPrompt: 'fixed',
      presets: [makePreset('p1'), makePreset('q')],
      repeats: 3,
    });
    expect(totalCount(withInline)).toBe(totalCount(without));
    expect(totalCount(withInline)).toBe(6);
  });
});

describe('expand', () => {
  it('usePresets=false일 때 고정 프롬프트만 N장 나온다', () => {
    const t = makeTemplate({ usePresets: false, repeats: 3, fixedPrompt: 'fixed only' });
    const items = [...expand(t, makeStubRng([]))];
    expect(items).toHaveLength(3);
    for (const [i, item] of items.entries()) {
      expect(item.idx).toBe(i);
      expect(item.prompt).toBe('fixed only');
      expect(item.fixedResolved).toBe('fixed only');
      expect(item.presetResolved).toBe('');
      expect(item.preset.text).toBe('');
    }
  });

  it('sequential 모드는 프리셋을 순서대로 순환하며 round가 증가한다', () => {
    const t = makeTemplate({
      mode: 'sequential',
      presets: [makePreset('a'), makePreset('b')],
      repeats: 2,
    });
    const items = [...expand(t, makeStubRng([]))]; // sequential이라 rng 미사용
    expect(items.map((i) => i.preset.text)).toEqual(['a', 'b', 'a', 'b']);
    expect(items.map((i) => i.round)).toEqual([0, 0, 1, 1]);
  });

  it('random 모드는 rng를 사용해 프리셋을 고른다', () => {
    const t = makeTemplate({
      mode: 'random',
      presets: [makePreset('a'), makePreset('b'), makePreset('c')],
      repeats: 1,
      fixedPrompt: 'fixed', // 중괄호 없음 → 인라인 랜덤은 rng 소비 안 함
    });
    // 프리셋 3개짜리 1회전 = 3장. 각 장마다 pickPreset이 rng 1회 소비.
    const rng = makeStubRng([0, 0.5, 0.9]);
    const items = [...expand(t, rng)];
    expect(items.map((i) => i.preset.text)).toEqual(['a', 'b', 'c']);
    expect(items.every((i) => i.round === undefined)).toBe(true);
  });

  it('override 인자가 총 장수를 강제한다', () => {
    const t = makeTemplate({ usePresets: false, repeats: 3, fixedPrompt: 'fixed' });
    expect([...expand(t, makeStubRng([]), 7)]).toHaveLength(7);
    expect([...expand(t, makeStubRng([]), 1)]).toHaveLength(1);
    expect([...expand(t, makeStubRng([]), 0)]).toHaveLength(0);
  });

  it('고정 프롬프트와 프리셋 양쪽에 인라인 랜덤을 적용하고 합쳐서 prompt를 만든다', () => {
    const t = makeTemplate({
      usePresets: true,
      fixedPrompt: '1girl, {red|blue} hair',
      presets: [makePreset('{smile|pout}')],
      mode: 'sequential',
      repeats: 1,
    });
    // 고정 쪽 rng 1회, 프리셋 쪽 rng 1회 — 이 순서(fixed 먼저, preset 나중)로 소비됨
    const rng = makeStubRng([0, 0.9]);
    const [item] = [...expand(t, rng)];
    expect(item!.fixedResolved).toBe('1girl, red hair');
    expect(item!.presetResolved).toBe('pout');
    expect(item!.prompt).toBe('1girl, red hair, pout');
    // preset 필드는 원본(치환 전) 텍스트를 그대로 보존한다
    expect(item!.preset.text).toBe('{smile|pout}');
  });

  it('total이 0이면 아무것도 안 나온다', () => {
    const t = makeTemplate();
    expect([...expand(t, makeStubRng([]), 0)]).toHaveLength(0);
  });
});

describe('preview', () => {
  it('기본 n=8개까지만 즉시 소비한다', () => {
    const t = makeTemplate({ usePresets: false, repeats: 20, fixedPrompt: 'x' });
    expect(preview(t)).toHaveLength(8);
  });

  it('n을 지정하면 그만큼만 반환한다', () => {
    const t = makeTemplate({ usePresets: false, repeats: 20, fixedPrompt: 'x' });
    expect(preview(t, 3)).toHaveLength(3);
  });

  it('총 장수가 n보다 적으면 있는 만큼만 반환한다', () => {
    const t = makeTemplate({ usePresets: false, repeats: 2, fixedPrompt: 'x' });
    expect(preview(t, 8)).toHaveLength(2);
  });

  it('ExpandedItem에 fixedResolved/presetResolved가 채워져서 고정/변형을 구분할 수 있다', () => {
    const t = makeTemplate({
      usePresets: true,
      fixedPrompt: 'fixed',
      presets: [makePreset('variant')],
      mode: 'sequential',
      repeats: 1,
    });
    const [item] = preview(t, 1);
    expect(item!.fixedResolved).toBe('fixed');
    expect(item!.presetResolved).toBe('variant');
    expect(item!.prompt).toBe('fixed, variant');
  });
});
