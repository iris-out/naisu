/**
 * Discord 웹훅. content script → SW 메시지로 위임 (CORS).
 */

import type { DiscordSettings } from './storage';

export type DiscordEvent =
  | { kind: 'start'; total: number; estimateMin: number; anlasUsed: number; templateName: string }
  | { kind: 'progress'; done: number; total: number; etaSec: number; anlasLeft: number }
  | { kind: 'item'; idx: number; total: number; prompt: string; seed?: number }
  | { kind: 'pause'; reason: string }
  | { kind: 'done'; total: number; durationSec: number; anlasUsed: number }
  | { kind: 'error'; message: string };

export async function postEvent(s: DiscordSettings, e: DiscordEvent): Promise<void> {
  if (!s.url) return;
  if (!s.events[e.kind]) return;

  const body = renderBody(e);
  try {
    await chrome.runtime.sendMessage({
      type: 'naisu.webhook',
      payload: { url: s.url, body },
    });
  } catch { /* SW 비활성 시 무시 */ }
}

function renderBody(e: DiscordEvent): { content: string } {
  type E = DiscordEvent;
  const fmt: { [K in E['kind']]: (x: Extract<E, { kind: K }>) => string } = {
    start: (x) =>
      `▶ **배치 시작** · ${x.templateName} — 총 ${x.total}장 · 예상 ${x.estimateMin}분 · ~${x.anlasUsed} ₳`,
    progress: (x) => {
      const m = Math.floor(x.etaSec / 60);
      const s = Math.round(x.etaSec % 60);
      return `진행 ${x.done}/${x.total} · 남은 ${m}분 ${s}초 · 잔여 ${x.anlasLeft.toLocaleString()} ₳`;
    },
    item: (x) => `· #${String(x.idx + 1).padStart(3, '0')}/${x.total}${x.seed ? ` · seed ${x.seed}` : ''}`,
    pause: (x) => `⏸ **일시정지** — ${x.reason}`,
    done: (x) => {
      const m = Math.floor(x.durationSec / 60);
      const s = Math.round(x.durationSec % 60);
      return `✅ **완료** — ${x.total}장 · ${m}분 ${s}초 · 사용 ${x.anlasUsed} ₳`;
    },
    error: (x) => `🛑 **에러** — ${x.message}`,
  };
  return { content: (fmt[e.kind] as (x: E) => string)(e) };
}
