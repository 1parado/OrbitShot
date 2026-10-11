import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    sourcemap: false,
    // 扩展多页面环境会残留指向 HTML 入口私有模块的 modulepreload 提示，
    // 在 MV3 里触发 cross-world mismatch 警告（无实际加载作用），直接关闭
    modulePreload: false,
    rollupOptions: {
      // 独立扩展页面（crxjs 不处理 web_accessible_resources 的 html 入口，
      // 用 Vite 原生多页构建补上；side_panel.default_path 的入口由 crxjs 处理，
      // 这里补充多页构建入口）
      input: {
        staging: 'src/staging/index.html',
        sidepanel: 'src/sidepanel/index.html',
        'formula-offscreen': 'src/background/formula-offscreen.html',
      },
    },
  },
})
