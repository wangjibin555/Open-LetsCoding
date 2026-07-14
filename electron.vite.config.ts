import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        // 预览入口仅在 LC_PREVIEW=1 时构建（视觉核对用），不进生产包
        input: process.env.LC_PREVIEW
          ? { index: 'src/renderer/index.html', preview: 'src/renderer/preview.html' }
          : { index: 'src/renderer/index.html' }
      }
    }
  }
})
