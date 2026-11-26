import { getToken } from '~/lib/api'

// Penjaga rute sisi klien: halaman selain /login wajib memiliki token.
export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) return
  const token = getToken()
  if (!token && to.path !== '/login') {
    return navigateTo('/login')
  }
  if (token && to.path === '/login') {
    return navigateTo('/')
  }
})
