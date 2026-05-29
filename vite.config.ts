import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.IMAGE_TOOLS_API_TARGET || 'http://127.0.0.1:19080',
        changeOrigin: true,
      },
    },
  },
})
