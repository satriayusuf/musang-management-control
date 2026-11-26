import tailwindcss from '@tailwindcss/vite'

// Muse Management Control — frontend statis (SPA), tanpa SSR.
// File hasil generate di .output/public diserve langsung oleh Nginx;
// dashboard berbicara ke backend hanya lewat REST API (/api) dan WebSocket (/ws).
export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: '2025-01-01',
  modules: ['@pinia/nuxt'],
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()],
  },
  runtimeConfig: {
    public: {
      // Default "/api" (relatif, di-proxy Nginx). Untuk dev lokal timpa dengan
      // NUXT_PUBLIC_API_BASE=http://127.0.0.1:3001/api
      apiBase: '/api',
    },
  },
  app: {
    head: {
      title: 'Muse Management Control',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Panel kendali terpusat untuk memantau dan mengendalikan agent Muse.' },
      ],
      htmlAttrs: { lang: 'id' },
    },
  },
  typescript: {
    strict: true,
  },
})
