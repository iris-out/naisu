/**
 * 설정 항목 레지스트리.
 *
 * 왜 필요한가: 검색 · 항목별 되돌리기 · 내보내기/가져오기 · 요약 배지 · 위험 경고
 * 다섯 기능이 전부 "설정 항목이 무엇무엇 있는지" 아는 코드를 요구한다.
 * 그 지식이 각 화면의 마크업에 흩어져 있으면 같은 목록을 다섯 번 하드코딩하게 되고,
 * 항목을 하나 추가할 때마다 다섯 곳을 고쳐야 한다.
 *
 * 다만 **메타데이터만** 담는다 — 입력 컨트롤을 그리는 일은 각 화면이 계속 직접 한다.
 * 렌더링까지 선언으로 빨아들이면 화면마다 예외가 생겨 오히려 복잡해진다
 * (프리셋 목록·전개 미리보기·이력 검색처럼 단순 필드가 아닌 것들이 있다).
 */

import { DEFAULTS, type Settings } from '../lib/storage';
import { opsSummary } from '../lib/image-ops';

/** 후처리 요약 — 화면·검색·홈 배지가 같은 문장을 쓰도록 여기 한 번만 정의한다. */
function describeOps(s: Settings): string {
  return opsSummary(s.imageOps) || '없음';
}

/** 이 항목이 사는 화면 — 검색 결과에서 바로 이동하는 데 쓴다 */
export type ScreenId = 'batch' | 'safety' | 'storage' | 'output' | 'discord' | 'about' | 'home';

export type RiskLevel = 'ok' | 'warn' | 'danger';

export interface RiskVerdict {
  level: RiskLevel;
  /** warn/danger일 때 화면에 그대로 보여줄 문장 */
  message?: string;
}

export interface SettingField {
  /** chrome.storage의 Settings 키. 되돌리기·내보내기가 이 키로 동작한다 */
  key: keyof Settings;
  screen: ScreenId;
  /** 화면에 쓰이는 것과 같은 라벨 */
  label: string;
  /** 상시 노출 설명 (hover 툴팁 대체) */
  help?: string;
  /** 검색용 별칭 — 사용자가 실제로 칠 법한 말 */
  keywords?: string[];
  /**
   * 현재 값을 사람 문장으로. 홈 메뉴 요약·검색 결과·상세 화면이 같은 문장을 쓴다.
   * 값을 직접 꺼내 쓰므로 키별로 타입이 정확히 좁혀진다.
   */
  describe?: (s: Settings) => string;
  /** 위험 구간이면 경고. 약관 관련 문구가 코드 여러 곳에 흩어지지 않게 여기 한 곳에 둔다 */
  risk?: (s: Settings) => RiskVerdict;
}

/** 기본 생성 간격보다 빠르면 NAI 약관 §9.1.6("excessive strain")에 저촉될 수 있다 */
const SAFE_COOLDOWN_MS = DEFAULTS.cooldownMs;

function sec(ms: number): string {
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}초`;
}

export const FIELDS: SettingField[] = [
  // ---------------- 안전 설정 ----------------
  {
    key: 'cooldownMs',
    screen: 'safety',
    label: '생성 간격',
    help: '이미지 한 장을 만든 뒤 다음 장까지 기다리는 시간입니다.',
    keywords: ['쿨다운', '딜레이', 'delay', 'cooldown', '속도', '간격'],
    describe: (s) => `${sec(s.cooldownMs)} 간격`,
    risk: (s) =>
      s.cooldownMs < SAFE_COOLDOWN_MS
        ? {
            level: s.cooldownMs < SAFE_COOLDOWN_MS / 2 ? 'danger' : 'warn',
            message:
              `기본값(${sec(SAFE_COOLDOWN_MS)})보다 짧습니다. NovelAI 약관 §9.1.6은 ` +
              '서비스가 정한 제한을 무시하거나 과도한 부하를 주는 자동화를 금지합니다.',
          }
        : { level: 'ok' },
  },
  {
    key: 'anlasFloor',
    screen: 'safety',
    label: 'Anlas 최솟값',
    help: '남은 Anlas가 이 값보다 적어지면 배치를 자동으로 멈춥니다.',
    keywords: ['anlas', '하한', '최소', '잔량', '크레딧'],
    describe: (s) => `${s.anlasFloor.toLocaleString()} 이하면 ${s.onAnlasFloor === 'pause' ? '일시정지' : '중단'}`,
  },
  {
    key: 'onAnlasFloor',
    screen: 'safety',
    label: '하한 도달 시 동작',
    help: '중단하면 배치가 끝나고, 일시정지하면 충전 후 이어서 실행할 수 있습니다.',
    keywords: ['중단', '일시정지', '재개'],
    describe: (s) => (s.onAnlasFloor === 'pause' ? '일시정지 후 재개 가능' : '배치 중단'),
  },
  {
    key: 'maxRetries',
    screen: 'safety',
    label: '오류 재시도',
    help: '연속 실패를 몇 번까지 허용할지. 1초 → 2초 → 4초 간격으로 다시 시도합니다.',
    keywords: ['재시도', 'retry', '실패', '오류'],
    describe: (s) => `재시도 ${s.maxRetries}회`,
    risk: (s) => (s.maxRetries === 0 ? { level: 'warn', message: '한 번만 실패해도 배치가 멈춥니다.' } : { level: 'ok' }),
  },
  {
    key: 'timeoutMs',
    screen: 'safety',
    label: '생성 제한 시간',
    help: '이미지 한 장에 허용하는 최대 대기 시간입니다. 넘기면 실패로 처리합니다.',
    keywords: ['타임아웃', 'timeout', '제한', '대기'],
    describe: (s) => `장당 최대 ${Math.round(s.timeoutMs / 1000)}초`,
  },

  {
    key: 'keepAwake',
    screen: 'safety',
    label: '절전 방지',
    help: '배치가 도는 동안 시스템이 잠들지 않게 합니다. 화면은 꺼져도 됩니다.',
    keywords: ['절전', '슬립', 'sleep', '대기모드', '깨어'],
    describe: (s) => (s.keepAwake ? '배치 중 절전 안 함' : '절전 허용'),
    risk: (s) =>
      s.keepAwake
        ? { level: 'ok' }
        : { level: 'warn', message: '긴 배치 중 시스템이 잠들면 생성이 멈출 수 있습니다.' },
  },

  // ---------------- 다운로드 ----------------
  {
    key: 'downloadMode',
    screen: 'storage',
    label: '저장 방식',
    help: '이미지에 박힌 생성 정보(프롬프트·시드)를 얼마나 지울지 정합니다.',
    keywords: ['하드클린', '클린', '원본', '메타데이터', 'exif', '제거'],
    describe: (s) =>
      ({ hardclean: '하드클린', clean: '클린', raw: '원본', both: '클린+원본' })[s.downloadMode],
    risk: (s) =>
      s.downloadMode === 'raw'
        ? { level: 'danger', message: '프롬프트·시드가 파일에 그대로 남습니다.' }
        : s.downloadMode === 'hardclean'
          ? { level: 'ok' }
          : { level: 'warn', message: '알파 채널 은닉 데이터가 남을 수 있습니다(하드클린이 가장 확실).' },
  },
  {
    key: 'downloadFolder',
    screen: 'storage',
    label: '저장 폴더',
    help: '브라우저 다운로드 폴더 하위 경로입니다.',
    keywords: ['폴더', '경로', 'folder', '저장 위치'],
    describe: (s) => `${s.downloadFolder}/`,
  },
  {
    key: 'batchFolderTemplate',
    screen: 'storage',
    label: '배치 하위 폴더',
    help: '배치마다 만드는 하위 폴더입니다. 비우면 하위 폴더 없이 바로 저장합니다.',
    keywords: ['하위 폴더', '배치 폴더', '템플릿'],
    describe: (s) => (s.batchFolderTemplate ? s.batchFolderTemplate : '하위 폴더 없음'),
  },
  {
    key: 'filenameTemplate',
    screen: 'storage',
    label: '파일 이름',
    help: '토큰을 조합해 파일명을 만듭니다.',
    keywords: ['파일명', '이름', 'filename', '토큰'],
    describe: (s) => s.filenameTemplate,
  },
  {
    key: 'conflictAction',
    screen: 'storage',
    label: '이름 충돌 시',
    help: '같은 파일명이 이미 있을 때의 동작입니다.',
    keywords: ['덮어쓰기', '충돌', 'overwrite', 'conflict', '중복'],
    describe: (s) =>
      ({ uniquify: '번호 붙이기', overwrite: '덮어쓰기', prompt: '매번 묻기' })[s.conflictAction],
    risk: (s) =>
      s.conflictAction === 'overwrite'
        ? { level: 'warn', message: '파일명이 겹치면 이전 이미지가 지워집니다.' }
        : s.conflictAction === 'prompt'
          ? { level: 'warn', message: '자동 배치 중에도 매번 저장 대화상자가 떠서 실행이 멈춥니다.' }
          : { level: 'ok' },
  },
  {
    key: 'writeManifest',
    screen: 'storage',
    label: '배치 매니페스트',
    help: '배치 폴더에 프롬프트·시드 목록 CSV를 남깁니다.',
    keywords: ['csv', '매니페스트', '목록', '재현', 'manifest'],
    describe: (s) => (s.writeManifest ? '저장함' : '저장 안 함'),
  },
  {
    key: 'cacheLimit',
    screen: 'storage',
    label: '원본 캐시 장수',
    help: '"다시 저장"에 필요한 원본을 몇 장까지 보관할지 정합니다.',
    keywords: ['캐시', '다시 저장', '복구', 'cache'],
    describe: (s) => (s.cacheLimit > 0 ? `${s.cacheLimit}장` : '보관 안 함'),
    risk: (s) =>
      s.cacheLimit > 0
        ? { level: 'ok' }
        : { level: 'warn', message: '하드클린이 실패해도 다시 저장할 수 없습니다.' },
  },
  {
    key: 'imageOps',
    screen: 'output',
    label: '저장 후처리',
    help: '품질·포맷·워터마크·크레딧. 원본(raw) 모드에는 적용되지 않습니다.',
    keywords: ['품질', '워터마크', '포맷', 'jpeg', 'webp'],
    describe: (s) => describeOps(s),
  },
  {
    key: 'autoResumeMin',
    screen: 'safety',
    label: 'Anlas 자동 재개',
    help: 'Anlas 하한으로 일시정지한 뒤 자동으로 이어서 실행하기까지의 대기입니다.',
    keywords: ['자동 재개', '충전', 'resume', '이어서'],
    describe: (s) => (s.autoResumeMin > 0 ? `${s.autoResumeMin}분마다 확인` : '안 함'),
  },
  {
    key: 'offerResume',
    screen: 'safety',
    label: '끊긴 배치 이어하기 제안',
    help: '새로고침 등으로 끊긴 배치가 있으면 패널에서 이어하기를 제안합니다.',
    keywords: ['이어하기', '복구', '새로고침', 'resume'],
    describe: (s) => (s.offerResume ? '제안함' : '제안 안 함'),
  },
  {
    key: 'keepColorProfile',
    screen: 'storage',
    label: '색상 프로파일 유지',
    help: 'ICC 프로파일을 남깁니다. 하드클린에서는 JPEG로 다시 인코딩하므로 의미가 없습니다.',
    keywords: ['icc', '색상', '프로파일', '컬러'],
    describe: (s) => (s.keepColorProfile ? '유지' : '제거'),
  },

  // ---------------- 알림 ----------------
  {
    key: 'notifications',
    screen: 'discord',
    label: '브라우저 알림',
    help: 'Discord를 쓰지 않아도 배치 완료·오류를 알려 줍니다.',
    keywords: ['알림', '노티', 'notification', '완료'],
    describe: (s) => {
      const on = Object.entries(s.notifications).filter(([, v]) => v).length;
      return on === 0 ? '모두 꺼짐' : `${on}종 켜짐`;
    },
  },
  {
    key: 'discord',
    screen: 'discord',
    label: 'Discord 웹훅',
    help: '배치 진행 상황을 Discord 채널로 보냅니다.',
    keywords: ['디스코드', 'discord', '웹훅', 'webhook'],
    describe: (s) => {
      if (!s.discord.url) return '연결 안 됨';
      const on = Object.values(s.discord.events).filter(Boolean).length;
      return `연결됨 · 이벤트 ${on}종`;
    },
  },

  // ---------------- 외형 ----------------
  {
    key: 'panelLayout',
    screen: 'home',
    label: '패널 모양',
    help: 'NAI 화면에 뜨는 플로팅 패널의 형태입니다.',
    keywords: ['패널', '레일', '카드', '플로팅', '모양'],
    describe: (s) => (s.panelLayout === 'rail' ? '아이콘 레일' : '기본 카드'),
  },
  {
    key: 'panelTheme',
    screen: 'about',
    label: '패널 테마',
    help: '시스템을 고르면 OS 다크 모드 설정을 따릅니다.',
    keywords: ['테마', '다크', '라이트', 'theme', 'dark'],
    describe: (s) => ({ light: '라이트', dark: '다크', system: '시스템' })[s.panelTheme],
  },
  {
    key: 'panelCount',
    screen: 'home',
    label: '생성 장수',
    help: '패널의 ▶ 버튼을 눌렀을 때 만들 장수입니다.',
    keywords: ['장수', '개수', 'count'],
    describe: (s) => `${s.panelCount}장`,
  },

  // ---------------- 데이터 ----------------
  {
    key: 'historyLimit',
    screen: 'about',
    label: '이력 보관 개수',
    help: '이 개수를 넘으면 오래된 이력부터 지웁니다.',
    keywords: ['이력', '히스토리', '보관', 'history'],
    describe: (s) => `${s.historyLimit.toLocaleString()}개까지`,
  },
];

/** 화면 이름 — 검색 결과에 "어디에 있는지" 표시할 때 쓴다 */
export const SCREEN_LABELS: Record<ScreenId, string> = {
  home: '홈',
  batch: '배치',
  safety: '안전 설정',
  storage: '다운로드',
  output: '저장 후처리',
  discord: '알림',
  about: '정보',
};

export function fieldsOfScreen(screen: ScreenId): SettingField[] {
  return FIELDS.filter((f) => f.screen === screen);
}

export function findField(key: keyof Settings): SettingField | undefined {
  return FIELDS.find((f) => f.key === key);
}

/**
 * 설정 검색. 라벨 · 설명 · 별칭 · 현재 값 문장까지 훑는다.
 * 항목이 늘어도 여기 손댈 일이 없다 — FIELDS에 추가하면 자동으로 검색된다.
 */
export function searchFields(query: string, settings: Settings): SettingField[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return FIELDS.filter((f) => {
    const hay = [
      f.label,
      f.help ?? '',
      SCREEN_LABELS[f.screen],
      ...(f.keywords ?? []),
      f.describe?.(settings) ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/** 지금 값 중 위험 구간에 있는 것들 — 화면 상단 배지에 쓴다 */
export function riskOfScreen(screen: ScreenId, settings: Settings): RiskVerdict {
  let worst: RiskVerdict = { level: 'ok' };
  for (const f of fieldsOfScreen(screen)) {
    const v = f.risk?.(settings);
    if (!v) continue;
    if (v.level === 'danger') return v;
    if (v.level === 'warn' && worst.level === 'ok') worst = v;
  }
  return worst;
}

/** 항목 하나를 기본값으로 (P9) */
export function defaultPatch(key: keyof Settings): Partial<Settings> {
  return { [key]: DEFAULTS[key] } as Partial<Settings>;
}

/** 화면 하나를 통째로 기본값으로 */
export function defaultPatchOfScreen(screen: ScreenId): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const f of fieldsOfScreen(screen)) patch[f.key] = DEFAULTS[f.key];
  return patch as Partial<Settings>;
}

/** 현재 값이 기본값과 다른가 — "↺ 기본값" 버튼을 보일지 판단 */
export function isModified(key: keyof Settings, settings: Settings): boolean {
  return JSON.stringify(settings[key]) !== JSON.stringify(DEFAULTS[key]);
}
