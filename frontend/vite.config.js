import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // vite 8 bundles with rolldown, which requires a function here --
        // the object form silently warns and then throws at build time.
        // Match on package boundaries so recharts' own react-* deps
        // (react-smooth, victory-vendor, d3-*) land with recharts, not react.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (/node_modules[\\/](recharts|react-smooth|victory-vendor|d3-)/.test(id)) return 'vendor-recharts'
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
