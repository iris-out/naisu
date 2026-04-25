import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'NAISU — NovelAI 보조 도구',
  version: '0.1.0',
  description: 'NovelAI 이미지 안전 다운로더, 자동 제작 툴',
  permissions: ['downloads', 'storage', 'scripting', 'tabs'],
  host_permissions: ['https://novelai.net/*'],
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'NAISU',
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
  icons: {
    16: 'src/assets/icon-16.png',
    48: 'src/assets/icon-48.png',
    128: 'src/assets/icon-128.png',
  },
});
