/** 알림 화면 — 브라우저 알림(N03) + Discord 웹훅 URL과 알림 이벤트. */

import { getSettings, setSettings, type Settings } from '../../lib/storage';
import { sendMessage } from '../../lib/messages';
import { $, $$, must } from '../ui/dom';
import { setHint } from '../ui/status';
import { bindSwitch } from '../ui/switch';
import { helpLine } from '../ui/field-ui';
import type { Screen } from './types';

type DiscordEventKey = keyof Settings['discord']['events'];
type NotificationKey = keyof Settings['notifications'];

/** URL이 비었을 때 이벤트 카드를 잠근다 — 잠금/해제 시 표시만 갱신, 값은 그대로 둔다. */
function syncEventsLock(url: string): void {
  const card = $('#events-card');
  const hint = $('#events-locked-hint');
  if (!card) return;
  const locked = !url.trim();
  card.toggleAttribute('inert', locked);
  card.setAttribute('aria-disabled', String(locked));
  card.style.opacity = locked ? '0.45' : '';
  card.style.pointerEvents = locked ? 'none' : '';
  if (hint) hint.hidden = !locked;
}

function showTestResult(ok: boolean, message: string): void {
  const el = $('#webhook-test-result');
  if (!el) return;
  el.textContent = message;
  el.style.color = ok ? 'var(--ok)' : 'var(--r)';
  el.hidden = false;
}

export const discordScreen: Screen = {
  name: 'discord',

  render: () => `
    <section class="screen" data-screen="discord" hidden>
      <header class="hd sub">
        <button class="back" data-nav="home">←</button>
        <h2>알림</h2>
      </header>

      <div class="card">
        <div class="lbl">브라우저 알림</div>
        ${helpLine('Discord를 설정하지 않아도 동작합니다.')}
        <label class="row sw-row"><span class="row-ttl">배치 완료</span><span class="switch" data-nf="done"></span></label>
        <label class="row sw-row"><span class="row-ttl">오류로 중단</span><span class="switch" data-nf="error"></span></label>
        <label class="row sw-row"><span class="row-ttl">Anlas 하한 도달</span><span class="switch" data-nf="anlasFloor"></span></label>
      </div>

      <div class="card">
        <label class="full">
          <span class="lbl">Discord Webhook URL</span>
          <input type="text" id="webhook-url" placeholder="https://discord.com/api/webhooks/...">
        </label>
        <button class="btn" id="webhook-test" style="margin-top:8px;width:100%">테스트 전송</button>
        <div id="webhook-test-result" class="field-help" hidden></div>
      </div>

      <div class="card" id="events-card">
        <div class="lbl">알림 이벤트</div>
        <div id="events-locked-hint" class="field-risk" hidden>URL을 입력하면 사용할 수 있습니다.</div>
        <label class="row sw-row"><span class="row-ttl">배치 시작</span><span class="switch" data-ev="start"></span></label>
        <label class="row sw-row">
          <span>
            <span class="row-ttl">진행 상황</span>
            <span class="row-sub">매 <input type="number" id="progress-every" value="10" style="width:48px"> 장마다</span>
          </span>
          <span class="switch" data-ev="progress"></span>
        </label>
        <label class="row sw-row"><span class="row-ttl">이미지마다</span><span class="switch" data-ev="item"></span></label>
        <label class="row sw-row"><span class="row-ttl">일시정지</span><span class="switch" data-ev="pause"></span></label>
        <label class="row sw-row"><span class="row-ttl">배치 완료</span><span class="switch" data-ev="done"></span></label>
        <label class="row sw-row"><span class="row-ttl">오류</span><span class="switch" data-ev="error"></span></label>
      </div>
    </section>
  `,

  async mount() {
    const s = await getSettings();

    // ---- 브라우저 알림 ----
    $$('.switch[data-nf]').forEach((sw) => {
      const key = sw.dataset.nf as NotificationKey;
      bindSwitch(sw, s.notifications[key], async (v) => {
        const cur = await getSettings();
        await setSettings({ notifications: { ...cur.notifications, [key]: v } });
      });
    });

    // ---- Discord webhook URL ----
    const url = must<HTMLInputElement>('#webhook-url');
    url.value = s.discord.url;
    syncEventsLock(url.value);
    url.addEventListener('input', async () => {
      const cur = await getSettings();
      await setSettings({ discord: { ...cur.discord, url: url.value } });
      syncEventsLock(url.value);
    });

    $$('.switch[data-ev]').forEach((sw) => {
      const ev = sw.dataset.ev as DiscordEventKey;
      bindSwitch(sw, s.discord.events[ev], async (v) => {
        const cur = await getSettings();
        await setSettings({
          discord: { ...cur.discord, events: { ...cur.discord.events, [ev]: v } },
        });
      });
    });

    const every = must<HTMLInputElement>('#progress-every');
    every.value = String(s.discord.progressEvery);
    every.addEventListener('input', async () => {
      const cur = await getSettings();
      await setSettings({
        discord: { ...cur.discord, progressEvery: Math.max(1, Number(every.value) || 1) },
      });
    });

    must<HTMLButtonElement>('#webhook-test').addEventListener('click', async () => {
      const cur = await getSettings();
      if (!cur.discord.url) {
        setHint('Webhook URL을 먼저 입력해 주세요');
        showTestResult(false, 'Webhook URL을 먼저 입력해 주세요');
        return;
      }
      const r = await sendMessage('naisu.webhook', {
        url: cur.discord.url,
        body: { content: '✅ NAISU 테스트 메시지' },
      });
      const statusTxt = r?.status !== undefined ? ` (HTTP ${r.status})` : '';
      setHint(r?.ok ? '테스트 성공' : '테스트 실패');
      showTestResult(!!r?.ok, `${r?.ok ? '테스트 성공' : '테스트 실패'}${statusTxt}`);
    });
  },
};
