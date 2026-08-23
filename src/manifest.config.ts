import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'NAISU — NovelAI 보조 도구',
  version: '0.4.0',
  description: 'NovelAI 이미지 안전 다운로더, 자동 제작 툴',
  permissions: [
    'downloads',
    'storage',
    'scripting',
    'tabs',
    // 배치 완료·실패를 Discord 없이도 알리기 위해 (N03)
    'notifications',
    // 긴 배치가 시스템 절전으로 끊기지 않게 (배치 실행 중에만 요청하고 끝나면 해제)
    'power',
  ],
  host_permissions: ['https://novelai.net/*'],
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'NAISU',
  },
  // 좁은 팝업(396px)에서 프리셋을 편집하기 답답해서, 같은 화면을 넓게 여는 탭 (U11)
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://novelai.net/image*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  /**
   * 단축키 (N01). 실제 동작 배선은 service worker의 chrome.commands.onCommand.
   * 사용자는 chrome://extensions/shortcuts 에서 자유롭게 바꿀 수 있다.
   */
  commands: {
    'naisu-toggle-batch': {
      suggested_key: { default: 'Alt+Shift+S' },
      description: '자동 생성 시작 / 일시정지',
    },
    'naisu-save-image': {
      suggested_key: { default: 'Alt+Shift+D' },
      description: '현재 이미지 저장',
    },
    'naisu-stop-batch': {
      suggested_key: { default: 'Alt+Shift+X' },
      description: '자동 생성 중단',
    },
  },
  icons: {
    16: 'src/assets/icon-16.png',
    48: 'src/assets/icon-48.png',
    128: 'src/assets/icon-128.png',
  },
  /**
   * 번들된 Pretendard — 패널 CSS가 novelai.net 문서에 주입되므로, 폰트 파일을
   * 그 페이지에서 접근 가능하게 열어 줘야 한다. (CRXJS가 만드는 항목에 합쳐진다)
   */
  web_accessible_resources: [
    {
      resources: ['fonts/*.woff2', 'fonts/pretendard.css'],
      matches: ['https://novelai.net/*'],
    },
  ],
});
