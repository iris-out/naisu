/**
 * 팝업 진입점.
 *
 * 화면은 전부 screens/*.ts 가 소유한다 — 이 파일은 등록·마운트 순서만 책임진다.
 * 마크업도 각 화면 모듈이 들고 있어서 index.html은 빈 껍데기다.
 */

import './popup.css';
import { bindRouter, nav, registerScreens } from './router';
import { must } from './ui/dom';
import { homeScreen } from './screens/home';
import { batchScreen } from './screens/batch';
import { storageScreen } from './screens/storage';
import { safetyScreen } from './screens/safety';
import { discordScreen } from './screens/discord';
import { historyScreen } from './screens/history';
import { aboutScreen } from './screens/about';
import type { Screen } from './screens/types';

/** 등록 순서 = DOM 순서 = mount 순서 */
const SCREENS: Screen[] = [
  homeScreen,
  batchScreen,
  storageScreen,
  safetyScreen,
  discordScreen,
  historyScreen,
  aboutScreen,
];

async function main(): Promise<void> {
  const app = must('#app');
  app.innerHTML = SCREENS.map((s) => s.render()).join('\n');

  registerScreens(SCREENS);
  bindRouter();

  // mount는 순서대로 — 화면끼리 저장값을 읽고 쓰는 순서가 바뀌지 않도록 직렬로 둔다.
  for (const screen of SCREENS) {
    await screen.mount?.();
  }

  nav('home');
}

void main();
