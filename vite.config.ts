import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Forward /cc/* requests to the backend WebSocket server (port 32352).
      // The /cc prefix is stripped before forwarding, so /cc/api/foo → /api/foo.
      // WebSocket upgrade requests (/cc/ws) are also proxied for session streaming.
      '/cc': {
        target: 'http://127.0.0.1:32352',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cc/, ''),
        ws: true,
      },
    },
  },
})
