import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/cc': {
        target: 'http://127.0.0.1:32352',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cc/, ''),
        ws: true,
      },
    },
  },
})
