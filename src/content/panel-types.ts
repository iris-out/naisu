/**
 * 패널(A안) 안에서 오가는 값의 모양.
 *
 * overlay.ts / panel-popover.ts 가 서로를 import하면 순환이 생기므로,
 * 공유 타입은 어느 쪽에도 의존하지 않는 이 파일에만 둔다.
 */

import type { DownloadMode } from '../lib/storage';

/**
 * 이번 한 번의 저장에만 적용되는 예외.
 * 전역 설정을 건드리지 않고 "이 장만 원본으로" 같은 결정을 내리기 위한 것.
 */
export interface SaveOverride {
  mode?: DownloadMode;
}
