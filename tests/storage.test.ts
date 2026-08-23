/**
 * storage 스키마 · 마이그레이션 테스트.
 *
 * chrome.storage.local 을 메모리 객체로 흉내 낸다 — 실제 파일이나 브라우저에
 * 의존하지 않는다(합성 픽스처 원칙).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  DISCLAIMER_VERSION,
  STORAGE_KEYS,
  acceptDisclaimer,
  getSettings,
  getTemplate,
  getTemplateStore,
  isDisclaimerAccepted,
  renderFilename,
  renderFolder,
  setActiveTemplate,
  setSettings,
} from '../src/lib/storage';

let store: Record<string, unknown> = {};

function installFakeChrome(): void {
  const local = {
    async get(keys?: string | string[] | null) {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    async set(items: Record<string, unknown>) {
      Object.assign(store, items);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local } };
}

beforeEach(() => {
  store = {};
  installFakeChrome();
});

describe('설정', () => {
  it('저장된 값이 없으면 기본값을 그대로 돌려준다', async () => {
    const s = await getSettings();
    expect(s).toEqual(DEFAULTS);
  });

  it('일부만 저장돼 있어도 나머지는 기본값으로 채운다', async () => {
    store[STORAGE_KEYS.settings] = { downloadMode: 'hardclean' };
    const s = await getSettings();
    expect(s.downloadMode).toBe('hardclean');
    expect(s.cooldownMs).toBe(DEFAULTS.cooldownMs);
    expect(s.notifications).toEqual(DEFAULTS.notifications);
  });

  it('중첩된 discord.events 도 기본값과 병합된다', async () => {
    store[STORAGE_KEYS.settings] = { discord: { url: 'https://x', events: { done: false } } };
    const s = await getSettings();
    expect(s.discord.url).toBe('https://x');
    expect(s.discord.events.done).toBe(false);
    expect(s.discord.events.start).toBe(DEFAULTS.discord.events.start);
    expect(s.discord.progressEvery).toBe(DEFAULTS.discord.progressEvery);
  });

  it('patch 는 기존 값을 지우지 않는다', async () => {
    await setSettings({ anlasFloor: 42 });
    await setSettings({ cooldownMs: 3000 });
    const s = await getSettings();
    expect(s.anlasFloor).toBe(42);
    expect(s.cooldownMs).toBe(3000);
  });
});

describe('템플릿 마이그레이션', () => {
  it('아무것도 없으면 기본 템플릿 한 개짜리 스토어를 만든다', async () => {
    const store1 = await getTemplateStore();
    expect(store1.templates).toHaveLength(1);
    expect(store1.activeId).toBe(store1.templates[0]!.id);
    expect(store[STORAGE_KEYS.templates]).toBeDefined();
  });

  it('구버전 단일 템플릿을 첫 슬롯으로 이관하고 옛 키를 지운다', async () => {
    store[STORAGE_KEYS.legacyTemplate] = {
      name: 'my_template',
      fixedPrompt: '1girl, cat ears',
      usePresets: true,
      presets: [{ id: 'aaa', text: 'smile' }],
      mode: 'random',
      repeats: 7,
      randomSeed: false,
    };

    const migrated = await getTemplateStore();

    expect(migrated.templates).toHaveLength(1);
    const t = migrated.templates[0]!;
    expect(t.name).toBe('my_template');
    expect(t.fixedPrompt).toBe('1girl, cat ears');
    expect(t.presets).toEqual([{ id: 'aaa', text: 'smile' }]);
    expect(t.repeats).toBe(7);
    expect(t.randomSeed).toBe(false);
    // 새 필드는 기본값으로 채워진다
    expect(t.uc).toBe('');
    expect(t.characterPrompts).toEqual([]);
    // 옛 키는 사라진다
    expect(store[STORAGE_KEYS.legacyTemplate]).toBeUndefined();
  });

  it('이관은 멱등이다 — 두 번 읽어도 슬롯이 늘지 않는다', async () => {
    store[STORAGE_KEYS.legacyTemplate] = { name: 'x', presets: [] };
    const first = await getTemplateStore();
    const second = await getTemplateStore();
    expect(second.templates).toHaveLength(1);
    expect(second.templates[0]!.id).toBe(first.templates[0]!.id);
  });

  it('activeId 가 가리키는 슬롯이 없으면 첫 슬롯으로 되돌린다', async () => {
    const base = await getTemplateStore();
    store[STORAGE_KEYS.templates] = { templates: base.templates, activeId: '없는아이디' };
    const fixed = await getTemplateStore();
    expect(fixed.activeId).toBe(fixed.templates[0]!.id);
  });

  it('getTemplate 은 활성 슬롯을 돌려준다', async () => {
    const s = await getTemplateStore();
    const extra = { ...s.templates[0]!, id: 'second', name: 'template_02' };
    store[STORAGE_KEYS.templates] = { templates: [...s.templates, extra], activeId: s.activeId };

    expect((await getTemplate()).name).toBe('template_01');
    await setActiveTemplate('second');
    expect((await getTemplate()).name).toBe('template_02');
  });
});

describe('약관 동의', () => {
  it('기본은 미동의', async () => {
    expect(await isDisclaimerAccepted()).toBe(false);
  });

  it('동의하면 현재 버전으로 기록된다', async () => {
    await acceptDisclaimer();
    expect(await isDisclaimerAccepted()).toBe(true);
  });

  it('문구가 개정되면(저장된 버전이 낮으면) 다시 물어본다', async () => {
    store[STORAGE_KEYS.disclaimer] = {
      accepted: true,
      version: DISCLAIMER_VERSION - 1,
      acceptedAt: 1,
    };
    expect(await isDisclaimerAccepted()).toBe(false);
  });
});

describe('파일명 · 폴더 템플릿', () => {
  it('알려진 토큰을 치환한다', () => {
    const name = renderFilename('{seed}_{model}_{w}x{h}_{steps}', {
      seed: 123, model: 'NAI Diffusion V4.5', w: 832, h: 1216, steps: 23,
    });
    expect(name).toBe('123_NAI_Diffusion_V4.5_832x1216_23');
  });

  it('값이 없는 토큰은 안전한 대체값으로 채운다', () => {
    expect(renderFilename('{seed}', {})).toBe('noseed');
    expect(renderFilename('{model}', {})).toBe('nai');
  });

  it('알 수 없는 토큰은 빈 문자열로 지운다 (오타를 미리보기에서 바로 알아채도록)', () => {
    expect(renderFilename('a{nope}b', {})).toBe('ab');
  });

  it('영숫자가 아닌 토큰은 치환 대상이 아니라 글자 그대로 남는다', () => {
    // 치환 정규식이 \w 기반이라 한글/공백이 든 중괄호는 토큰으로 보지 않는다.
    // 파일명에 중괄호를 그대로 쓰고 싶은 경우를 막지 않으므로 의도된 동작.
    expect(renderFilename('a{한글}b', {})).toBe('a{한글}b');
  });

  it('경로에 쓸 수 없는 문자는 치환한다', () => {
    expect(renderFilename('{batch}', { batch: 'batch/2026:01' })).toBe('batch_2026_01');
  });

  it('폴더는 최상위 + 배치 하위를 합치고 빈 세그먼트를 버린다', () => {
    expect(renderFolder({ downloadFolder: 'naisu', batchFolderTemplate: '{batch}' }, { batch: 'b1' }))
      .toBe('naisu/b1');
    expect(renderFolder({ downloadFolder: 'naisu', batchFolderTemplate: '' }, {}))
      .toBe('naisu');
    expect(renderFolder({ downloadFolder: 'a/b', batchFolderTemplate: '{template}' }, { template: 't1' }))
      .toBe('a/b/t1');
  });
});
