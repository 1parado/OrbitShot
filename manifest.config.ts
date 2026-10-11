import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'OrbitShot — 截图 · 标注 · AI 路由',
  short_name: 'OrbitShot',
  version: '0.3.0',
  description: '截图 → 标注 → 环形菜单 → 一键发送到网页版 AI。Visual Context Router.',
  permissions: ['storage', 'tabs', 'clipboardWrite', 'scripting', 'contextMenus', 'sidePanel', 'offscreen'],
  host_permissions: ['<all_urls>'],
  // 截图暂存工作区（独立扩展页面；crxjs 会把列出的 html 作为入口构建）
  web_accessible_resources: [
    {
      resources: ['src/staging/index.html', 'katex-fonts/*'],
      matches: ['<all_urls>'],
    },
  ],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'OrbitShot 截图',
  },
  options_page: 'src/options/index.html',
  // 多模型对比工作台（Chrome 114+ Side Panel）
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  commands: {
    'take-screenshot': {
      suggested_key: { default: 'Alt+Shift+S' },
      description: '截取当前可视区域（框选）',
    },
    'open-staging': {
      suggested_key: { default: 'Alt+Shift+O' },
      description: '打开截图暂存区',
    },
  },
  icons: {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
})
