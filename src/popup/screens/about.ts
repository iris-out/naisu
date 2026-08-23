/**
 * 정보 화면 — 브랜드/버전, 설정 백업, 패널(테마·위치), 단축키, 저장소 사용량,
 * 이력 보관 설정, 약관 동의 상태, 초기화.
 */

import { clearHistory, getHistory, pruneHistoryToLimit } from '../../lib/history';
import {
  getSettings,
  setSettings,
  getDisclaimer,
  revokeDisclaimer,
  DISCLAIMER_VERSION,
  SETTINGS_RESET_KEYS,
  type PanelTheme,
} from '../../lib/storage';
import { exportBackup, importBackup, backupFilename } from '../../lib/settings-io';
import { trySendToTab } from '../../lib/messages';
import { icon } from '../../lib/icons';
import { $ } from '../ui/dom';
import { bindInput } from '../ui/input';
import { makeConfirmBtn } from '../ui/confirm';
import { bindSeg } from '../ui/seg';
import { helpLine, bindRevert } from '../ui/field-ui';
import { isModified } from '../settings-registry';
import { flashHint } from '../ui/status';
import type { Screen } from './types';

/** NAI 패널 위치 초기화는 이 URL의 활성 탭에서만 의미가 있다. */
const NAI_IMAGE_URL = 'https://novelai.net/image';

/**
 * chrome.storage.local.QUOTA_BYTES가 없는(또는 unlimitedStorage 미보유 환경에서 실제 상한과
 * 다를 수 있는) 경우 대비 가정치 — 실측한 값이 아니라 Chrome 문서 기준 기본 로컬 저장소
 * 상한(5MB)에 여유를 둔 추정값이다. 실제 환경별 상한 차이가 확인되면 이 상수를 교정할 것.
 */
const FALLBACK_QUOTA_BYTES = 10 * 1024 * 1024;
const STORAGE_WARN_PCT = 80;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

async function activeNaiTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith(NAI_IMAGE_URL) ? tab : null;
}

async function renderStorageUsage(): Promise<void> {
  const bytes = await chrome.storage.local.getBytesInUse(null);
  const quota = chrome.storage.local.QUOTA_BYTES ?? FALLBACK_QUOTA_BYTES;
  const pct = Math.min(100, Math.round((bytes / quota) * 100));

  const storageEl = $('#about-storage');
  if (storageEl) storageEl.textContent = `${formatBytes(bytes)} / ${formatBytes(quota)} (${pct}%)`;

  const fill = $('#about-storage-bar-fill');
  if (fill) {
    fill.style.width = `${pct}%`;
    fill.style.background = pct >= STORAGE_WARN_PCT ? 'var(--r)' : 'var(--fg)';
  }

  const warn = $('#about-storage-warn');
  if (warn) warn.hidden = pct < STORAGE_WARN_PCT;
}

async function renderHistoryCount(): Promise<void> {
  const [hist, settings] = await Promise.all([getHistory(), getSettings()]);
  const countEl = $('#about-hist-count');
  if (countEl) countEl.textContent = `${hist.length} / ${settings.historyLimit}개`;

  const excess = hist.length - Math.max(1, settings.historyLimit);
  const row = $('#hist-limit-prune-row');
  const countSpan = $('#hist-limit-prune-count');
  if (row) row.hidden = excess <= 0;
  if (countSpan) countSpan.textContent = String(Math.max(0, excess));
}

async function renderDisclaimerStatus(): Promise<void> {
  const disc = await getDisclaimer();
  const accepted = disc.accepted && disc.version >= DISCLAIMER_VERSION;

  const statusEl = $('#about-disclaimer-status');
  if (statusEl) statusEl.textContent = accepted ? `동의함 · ${formatDateTime(disc.acceptedAt)}` : '미동의';

  const revokeBtn = $<HTMLButtonElement>('#disclaimer-revoke-btn');
  if (revokeBtn) revokeBtn.hidden = !accepted;
}

/** 내보내기/가져오기 결과 한 줄 — 성공은 --ok, 실패는 --r 색으로 구분. */
function showBackupResult(ok: boolean, message: string): void {
  const el = $('#backup-import-result');
  if (!el) return;
  el.textContent = message;
  el.style.color = ok ? 'var(--ok)' : 'var(--r)';
  el.hidden = false;
}

async function handleExport(): Promise<void> {
  const backup = await exportBackup();
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  flashHint('설정을 내보냈습니다');
}

async function handleImportFile(file: File): Promise<void> {
  const text = await file.text();
  const result = await importBackup(text);
  showBackupResult(result.ok, result.message);
  if (result.ok) {
    flashHint('가져왔습니다 — 새로고침합니다');
    window.setTimeout(() => window.location.reload(), 900);
  }
}

export const aboutScreen: Screen = {
  name: 'about',

  render: () => `
    <section class="screen" data-screen="about" hidden>
      <header class="hd sub">
        <button class="back" data-nav="home">←</button>
        <h2>정보</h2>
      </header>

      <div class="about-brand">
        <div class="about-logo">NAISU<span style="color:var(--r)">.</span></div>
        <div class="about-ver" id="about-version">v—</div>
        <div class="about-desc">NovelAI 이미지 보조 도구</div>
      </div>

      <div class="card">
        <div class="lbl">설정 백업</div>
        ${helpLine(
          'PC를 바꾸거나 확장을 재설치해도 프롬프트·폴더·파일명 규칙을 다시 만들지 않도록 ' +
            '설정과 배치 템플릿을 파일 하나로 내보내고 불러올 수 있습니다. ' +
            '<b>이력(생성 기록)은 개인 데이터라 포함되지 않습니다.</b>',
        )}
        <div class="row gap">
          <button class="btn" id="backup-export-btn">${icon('download', 15)} 내보내기</button>
          <button class="btn" id="backup-import-btn">${icon('upload', 15)} 가져오기</button>
        </div>
        <input type="file" id="backup-import-file" accept="application/json" hidden>
        ${helpLine('가져오기는 현재 설정을 덮어씁니다.')}
        <div id="backup-import-result" class="field-help" hidden></div>
      </div>

      <div class="card">
        <div class="lbl">패널 테마</div>
        <span class="seg" id="about-theme-pick" role="radiogroup" aria-label="패널 테마" style="--seg-n:3">
          <span class="seg-indicator"></span>
          <button data-v="light">라이트</button>
          <button data-v="dark">다크</button>
          <button data-v="system">시스템</button>
        </span>
        ${helpLine('시스템을 고르면 OS 다크 모드 설정을 따릅니다.')}
        <button class="revert" id="theme-revert" hidden>${icon('rotate_ccw', 12)} 기본값</button>

        <div class="lbl" style="margin-top:10px">패널 위치 초기화</div>
        <button class="btn" id="about-reset-pos" style="width:100%">${icon('rotate_ccw', 15)} NAI 패널을 좌상단으로</button>
        ${helpLine('novelai.net/image 탭이 활성 탭일 때만 동작합니다.')}
      </div>

      <div class="card">
        <div class="lbl">단축키</div>
        <div class="kv-line">
          <span class="kv-key">${icon('play', 14)} 자동 생성 시작/일시정지</span>
          <span style="grid-column:2/-1;justify-self:end;font-variant-numeric:tabular-nums">Alt+Shift+S</span>
        </div>
        <div class="kv-line">
          <span class="kv-key">${icon('download', 14)} 현재 이미지 저장</span>
          <span style="grid-column:2/-1;justify-self:end;font-variant-numeric:tabular-nums">Alt+Shift+D</span>
        </div>
        <div class="kv-line">
          <span class="kv-key">${icon('square', 14)} 자동 생성 중단</span>
          <span style="grid-column:2/-1;justify-self:end;font-variant-numeric:tabular-nums">Alt+Shift+X</span>
        </div>
        <button class="btn" id="shortcuts-edit-btn" style="width:100%;margin-top:8px">${icon('keyboard', 15)} 단축키 바꾸기</button>
      </div>

      <div class="card">
        <div class="kv-line">
          <span class="kv-key">저장소 사용량</span>
          <span id="about-storage" style="font-variant-numeric:tabular-nums">—</span>
        </div>
        <div style="height:8px;border:1px solid var(--fg);overflow:hidden;margin:2px 0 6px">
          <div id="about-storage-bar-fill" style="height:100%;width:0%;background:var(--fg);transition:width 200ms"></div>
        </div>
        <div id="about-storage-warn" class="hint mini" style="color:var(--r)" hidden>
          저장 공간이 ${STORAGE_WARN_PCT}%를 넘었습니다 — 이력 보관 개수를 줄이거나 오래된 이력을 정리하세요.
        </div>
        <div class="kv-line">
          <span class="kv-key">저장된 이력</span>
          <span id="about-hist-count" style="font-variant-numeric:tabular-nums">—</span>
        </div>
      </div>

      <div class="card">
        <div class="lbl">이력 보관 개수 상한</div>
        <div class="kv-line">
          <span class="kv-key">최대 개수</span>
          <input type="number" id="hist-limit-input" min="1" value="500">
          <button class="revert" id="hist-limit-revert" hidden>${icon('rotate_ccw', 12)} 기본값</button>
        </div>
        <div id="hist-limit-prune-row" class="hint mini" style="margin-top:6px" hidden>
          상한을 초과한 이력이 <span id="hist-limit-prune-count">0</span>개 있습니다.
          <button class="btn danger" id="hist-limit-prune-btn" style="margin-top:6px;width:100%;font-size:11px;padding:6px 8px">지금 초과분 정리</button>
        </div>
      </div>

      <div class="card">
        <div class="lbl">자동 다운로드 약관 동의</div>
        <div class="kv-line">
          <span class="kv-key">상태</span>
          <span id="about-disclaimer-status">—</span>
        </div>
        <button class="btn danger" id="disclaimer-revoke-btn" style="width:100%;margin-top:8px;font-size:12px;padding:8px 10px" hidden>동의 철회</button>
        <div class="hint mini" style="margin-top:6px">철회하면 다음 자동 배치 실행 때 약관 동의 모달이 다시 표시됩니다.</div>
      </div>

      <div class="card" style="display:flex;flex-direction:column;gap:6px">
        <div class="lbl">초기화</div>
        ${helpLine('초기화 전에 위 "설정 백업 → 내보내기"로 미리 저장해 두는 것을 권장합니다.')}
        <button class="btn" id="reset-settings-btn" style="width:100%">설정 초기화</button>
        ${helpLine('설정만 지웁니다 — 이력은 남습니다.')}
        <button class="btn" id="reset-data-btn" style="width:100%">이력 초기화</button>
        ${helpLine('이력만 지웁니다 — 설정은 남습니다.')}
      </div>
    </section>
  `,

  async mount() {
    // ---- 설정 백업 ----
    const exportBtn = $<HTMLButtonElement>('#backup-export-btn');
    exportBtn?.addEventListener('click', () => void handleExport());

    const importBtn = $<HTMLButtonElement>('#backup-import-btn');
    const importFile = $<HTMLInputElement>('#backup-import-file');
    if (importBtn && importFile) {
      makeConfirmBtn(
        importBtn,
        async () => {
          importFile.click();
        },
        '정말 가져올까요? 한 번 더',
      );
      importFile.addEventListener('change', () => {
        const file = importFile.files?.[0];
        importFile.value = '';
        if (!file) return;
        void handleImportFile(file);
      });
    }

    // ---- 패널 테마 ----
    // bindSeg는 한 번만 호출해야 클릭 리스너가 중복 등록되지 않는다 — 되돌리기 버튼은
    // 이 한 번의 호출이 돌려준 activate 함수를 재사용해 선택 표시만 갱신한다.
    const themePick = $('#about-theme-pick');
    const themeRevertBtn = $<HTMLButtonElement>('#theme-revert');
    if (themePick) {
      const s = await getSettings();
      const activateTheme = bindSeg(themePick, s.panelTheme, async (v) => {
        const next = await setSettings({ panelTheme: v as PanelTheme });
        flashHint('패널 테마를 바꿨습니다');
        if (themeRevertBtn) themeRevertBtn.hidden = !isModified('panelTheme', next);
      });
      if (themeRevertBtn) {
        bindRevert(themeRevertBtn, 'panelTheme', async () => {
          const cur = await getSettings();
          activateTheme(cur.panelTheme);
        });
      }
    }

    // ---- 패널 위치 초기화 ----
    $<HTMLButtonElement>('#about-reset-pos')?.addEventListener('click', async () => {
      const tab = await activeNaiTab();
      if (!tab?.id) {
        flashHint('NovelAI 이미지 탭에서 실행해 주세요');
        return;
      }
      const resp = await trySendToTab(tab.id, 'naisu.ui.reset');
      flashHint(resp ? '패널 위치를 초기화했습니다' : '초기화 실패 — 탭을 새로고침 해주세요');
    });

    // ---- 단축키 바꾸기 ----
    $<HTMLButtonElement>('#shortcuts-edit-btn')?.addEventListener('click', () => {
      void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });

    // ---- 초기화 ----
    const settingsBtn = $<HTMLButtonElement>('#reset-settings-btn');
    if (settingsBtn) {
      makeConfirmBtn(
        settingsBtn,
        async () => {
          await chrome.storage.local.remove(SETTINGS_RESET_KEYS);
          window.location.reload();
        },
        '정말 초기화할까요? 한 번 더',
      );
    }

    const dataBtn = $<HTMLButtonElement>('#reset-data-btn');
    if (dataBtn) {
      makeConfirmBtn(
        dataBtn,
        async () => {
          await clearHistory();
          await aboutScreen.enter?.();
          // 홈 메뉴의 이력 개수는 홈으로 돌아갈 때 enter()가 다시 그린다 —
          // 다른 화면의 노드를 여기서 직접 건드리지 않는다.
        },
        '정말 삭제할까요? 한 번 더',
      );
    }

    const pruneBtn = $<HTMLButtonElement>('#hist-limit-prune-btn');
    if (pruneBtn) {
      makeConfirmBtn(
        pruneBtn,
        async () => {
          const s = await getSettings();
          await pruneHistoryToLimit(s.historyLimit);
          await renderHistoryCount();
          await renderStorageUsage();
        },
        '정말 삭제할까요? 한 번 더',
      );
    }

    const revokeBtn = $<HTMLButtonElement>('#disclaimer-revoke-btn');
    if (revokeBtn) {
      makeConfirmBtn(
        revokeBtn,
        async () => {
          await revokeDisclaimer();
          await renderDisclaimerStatus();
        },
        '정말 철회할까요? 한 번 더',
      );
    }

    // ---- 이력 보관 개수 되돌리기 ----
    const histLimitRevert = $<HTMLButtonElement>('#hist-limit-revert');
    if (histLimitRevert) {
      bindRevert(histLimitRevert, 'historyLimit', async () => {
        const s = await getSettings();
        const input = $<HTMLInputElement>('#hist-limit-input');
        if (input) input.value = String(s.historyLimit);
        await renderHistoryCount();
      });
    }
  },

  async enter() {
    const verEl = $('#about-version');
    if (verEl) verEl.textContent = `v${chrome.runtime.getManifest().version}`;

    const s = await getSettings();
    bindInput('#hist-limit-input', String(s.historyLimit), async (v) => {
      const n = Math.max(1, Number(v) || 500);
      await setSettings({ historyLimit: n });
      await renderHistoryCount();
    });

    await Promise.all([renderStorageUsage(), renderHistoryCount(), renderDisclaimerStatus()]);
  },
};
