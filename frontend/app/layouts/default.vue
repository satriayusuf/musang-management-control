<script setup lang="ts">
import {
  LayoutDashboard,
  Bot,
  Pickaxe,
  TerminalSquare,
  History,
  BarChart3,
  Settings as SettingsIcon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  TriangleAlert,
  UserRound,
  Workflow,
  Users,
} from 'lucide-vue-next'
import { api } from '~/lib/api'
import { userRoleLabel } from '~/lib/labels'

const route = useRoute()
const auth = useAuthStore()
const realtime = useRealtimeStore()

const collapsed = ref(false)
const alertCount = ref(0)

const navItems = computed(() => {
  const items = [
    { to: '/', label: 'Ringkasan', icon: LayoutDashboard },
    { to: '/agents', label: 'Agent', icon: Bot },
    { to: '/miners', label: 'Miner', icon: Pickaxe },
    { to: '/commands', label: 'Pusat Perintah', icon: TerminalSquare },
    { to: '/events', label: 'Event & Pemulihan', icon: History },
    { to: '/analytics', label: 'Analitik', icon: BarChart3 },
  ]
  // Otomasi: hanya untuk peran yang boleh menulis (OPERATOR/ADMIN).
  if (auth.canOperate) items.push({ to: '/automation', label: 'Otomasi', icon: Workflow })
  items.push({ to: '/settings', label: 'Pengaturan', icon: SettingsIcon })
  // Pengguna: hanya ADMIN.
  if (auth.isAdmin) items.push({ to: '/users', label: 'Pengguna', icon: Users })
  return items
})

function isActive(to: string): boolean {
  if (to === '/') return route.path === '/'
  return route.path === to || route.path.startsWith(`${to}/`)
}

async function refreshAlertCount() {
  try {
    const ov = await api.overview()
    alertCount.value = ov.active_alerts?.length ?? 0
  } catch {
    /* diamkan; badge tetap pada nilai terakhir */
  }
}

onMounted(() => {
  void refreshAlertCount()
})
useLiveRefresh(refreshAlertCount)
</script>

<template>
  <div class="flex min-h-screen bg-ink-950 text-ink-100">
    <!-- Sidebar -->
    <aside
      class="sticky top-0 flex h-screen shrink-0 flex-col border-r border-ink-700 bg-ink-900 transition-all duration-200"
      :class="collapsed ? 'w-16' : 'w-60'"
    >
      <div class="flex items-center gap-2.5 border-b border-ink-700 px-4 py-4">
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600">
          <Bot class="h-5 w-5 text-white" />
        </div>
        <div v-if="!collapsed" class="min-w-0">
          <p class="truncate text-sm font-semibold leading-tight">Muse Management Control</p>
          <p class="text-[11px] leading-tight text-ink-400">Panel Kendali Agent</p>
        </div>
      </div>

      <nav class="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        <NuxtLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
          :class="
            isActive(item.to)
              ? 'bg-ink-800 text-white'
              : 'text-ink-300 hover:bg-ink-800/60 hover:text-white'
          "
          :title="collapsed ? item.label : undefined"
        >
          <component :is="item.icon" class="h-4.5 w-4.5 shrink-0" />
          <span v-if="!collapsed" class="flex-1 truncate">{{ item.label }}</span>
          <span
            v-if="!collapsed && item.to === '/' && alertCount > 0"
            class="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
          >
            {{ alertCount }}
          </span>
        </NuxtLink>
      </nav>

      <!-- Status koneksi -->
      <div class="border-t border-ink-700 px-4 py-3">
        <div class="flex items-center gap-2 text-xs" :title="collapsed ? (realtime.connected ? 'Terhubung' : 'Terputus') : undefined">
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :class="realtime.connected ? 'bg-emerald-400' : 'bg-red-500'"
          />
          <span v-if="!collapsed" class="text-ink-300">
            {{ realtime.connected ? 'Terhubung' : 'Terputus' }}
          </span>
          <span v-if="!collapsed && alertCount > 0" class="ml-auto inline-flex items-center gap-1 text-amber-400">
            <TriangleAlert class="h-3.5 w-3.5" />
            {{ alertCount }}
          </span>
        </div>
      </div>

      <!-- Profil admin -->
      <div class="border-t border-ink-700 px-3 py-3">
        <div class="flex items-center gap-2.5">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-700">
            <UserRound class="h-4 w-4 text-ink-300" />
          </div>
          <div v-if="!collapsed" class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-ink-100">{{ auth.email || 'Administrator' }}</p>
            <p class="mt-0.5">
              <span
                class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset"
                :class="
                  auth.role === 'ADMIN' || auth.role === ''
                    ? 'bg-indigo-500/10 text-indigo-300 ring-indigo-500/30'
                    : auth.role === 'OPERATOR'
                      ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30'
                      : 'bg-zinc-500/10 text-zinc-300 ring-zinc-500/30'
                "
              >
                {{ auth.role ? userRoleLabel(auth.role) : 'Administrator' }}
              </span>
            </p>
          </div>
          <button
            class="rounded-md p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-white"
            title="Keluar"
            @click="auth.logout()"
          >
            <LogOut class="h-4 w-4" />
          </button>
        </div>
        <button
          class="mt-2 flex w-full items-center justify-center gap-2 rounded-md py-1.5 text-xs text-ink-400 transition-colors hover:bg-ink-800 hover:text-white"
          :title="collapsed ? 'Lebarkan sidebar' : 'Ciutkan sidebar'"
          @click="collapsed = !collapsed"
        >
          <PanelLeftOpen v-if="collapsed" class="h-4 w-4" />
          <PanelLeftClose v-else class="h-4 w-4" />
          <span v-if="!collapsed">Ciutkan</span>
        </button>
      </div>
    </aside>

    <!-- Konten utama -->
    <main class="min-w-0 flex-1">
      <div class="mx-auto w-full max-w-[1400px] px-5 py-6 lg:px-8">
        <slot />
      </div>
    </main>
  </div>
</template>
