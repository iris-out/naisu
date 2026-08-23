/** 팝업 하단 힌트 줄 / 홈 헤더 상태 텍스트. 여러 화면이 함께 쓴다. */

import { $ } from './dom';

const DEFAULT_HINT = '자동으로 저장됩니다';

export function setHint(text: string): void {
  const el = $('#hint');
  if (el) el.textContent = text;
}

/** "저장됨" 처럼 잠깐 보여주고 원래 문구로 돌아가는 힌트. */
export function flashHint(text: string, ms = 1000): void {
  setHint(text);
  setTimeout(() => setHint(DEFAULT_HINT), ms);
}

export function setHeadStat(text: string): void {
  const el = $('#head-stat');
  if (el) el.textContent = text;
}
