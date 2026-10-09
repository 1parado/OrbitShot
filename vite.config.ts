import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    sourcemap: false,
    rollupOptions: {
      // 截图暂存工作区：独立扩展页面（crxjs 不处理 web_accessible_resources 的 html 入口，
      // 用 Vite 原生多页构建补上；产物落在 dist/src/staging/index.html）
      input: { staging: 'src/staging/index.html' },
    },
  },
})
