/**
 * 설정 내보내기 / 가져오기 (P12).
 *
 * PC를 바꾸거나 확장을 재설치하면 프롬프트·폴더·파일명 규칙을 처음부터 다시 만들어야 했다.
 * 이력은 개인 데이터라 제외하고, 재현에 필요한 설정과 템플릿만 담는다.
 */

import {
  DEFAULTS,
  getSettings,
  getTemplateStore,
  setSettings,
  setTemplateStore,
  type BatchTemplate,
  type Settings,
  type TemplateStore,
} from './storage';

/** 형식이 바뀌면 올린다. 가져오기 쪽에서 이 값을 보고 거절하거나 변환한다. */
export const BACKUP_VERSION = 1;

export interface NaisuBackup {
  format: 'naisu-settings';
  version: number;
  exportedAt: string;
  settings: Settings;
  templates: TemplateStore;
}

export async function exportBackup(): Promise<NaisuBackup> {
  const [settings, templates] = await Promise.all([getSettings(), getTemplateStore()]);
  // 마지막으로 본 이미지 메타는 캐시일 뿐이라 내보내지 않는다
  const { lastMeta: _lastMeta, ...clean } = settings;
  // ⚠ Discord 웹훅 URL은 사실상 자격증명이다 — 그 URL을 가진 사람은 누구나 해당 채널에
  //   글을 쓸 수 있다. 백업 파일은 남에게 보내지거나 문제 해결용으로 공유되기 쉬우므로
  //   URL만 비워서 내보낸다(이벤트 on/off 설정은 그대로 살린다).
  const safe: Settings = { ...clean, discord: { ...clean.discord, url: '' } } as Settings;
  return {
    format: 'naisu-settings',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: safe,
    templates,
  };
}

export interface ImportResult {
  ok: boolean;
  /** 사용자에게 그대로 보여줄 문장 */
  message: string;
  templateCount?: number;
}

/**
 * 가져오기. 남이 만든 파일일 수 있으므로 형식을 확인하고,
 * 모르는 키는 조용히 버린 뒤 DEFAULTS와 병합해 항상 완전한 설정을 만든다.
 */
export async function importBackup(raw: string): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'JSON을 읽을 수 없습니다 — 파일이 손상됐거나 형식이 다릅니다.' };
  }

  const b = parsed as Partial<NaisuBackup>;
  if (b.format !== 'naisu-settings') {
    return { ok: false, message: 'NAISU 설정 파일이 아닙니다.' };
  }
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) {
    return {
      ok: false,
      message: `더 새로운 형식(v${String(b.version)})입니다. 확장을 업데이트한 뒤 다시 시도해 주세요.`,
    };
  }

  // 아는 키만 골라 담는다 — 모르는 키가 섞여 들어와 설정을 오염시키지 않게
  const incoming = (b.settings ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  let applied = 0;
  for (const key of Object.keys(DEFAULTS) as Array<keyof Settings>) {
    if (key in incoming) {
      patch[key] = incoming[key];
      applied++;
    }
  }
  await setSettings(patch as Partial<Settings>);

  let templateCount = 0;
  const store = b.templates;
  if (store && Array.isArray(store.templates) && store.templates.length > 0) {
    const templates = store.templates.filter(
      (t): t is BatchTemplate => !!t && typeof t.id === 'string' && typeof t.name === 'string',
    );
    if (templates.length > 0) {
      const activeId = templates.some((t) => t.id === store.activeId) ? store.activeId : templates[0]!.id;
      await setTemplateStore({ templates, activeId });
      templateCount = templates.length;
    }
  }

  return {
    ok: true,
    message:
      `설정 ${applied}개${templateCount ? ` · 템플릿 ${templateCount}개` : ''}를 가져왔습니다. ` +
      'Discord 웹훅 URL은 백업에 포함되지 않으므로 다시 입력해 주세요.',
    templateCount,
  };
}

/** 파일명은 날짜를 넣어 여러 번 받아도 안 겹치게 */
export function backupFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `naisu-settings-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
}
