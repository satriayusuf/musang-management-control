<script setup lang="ts">
import { Search, Plus, Copy, Check, Eye, Send, Ban, Trash2, LoaderCircle } from 'lucide-vue-next'
import { api, type AgentSummary } from '~/lib/api'
import { fmtDateTime, fmtRelative } from '~/lib/format'

const agents = ref<AgentSummary[]>([])
const total = ref(0)

const auth = useAuthStore()
/** Pairing & pencabutan token hanya untuk ADMIN (CONTRACT-3 §1). */
const isAdmin = computed(() => auth.isAdmin)
const page = ref(1)
const pageSize = 20
const loading = ref(true)
const loadError = ref('')

const search = ref('')
const statusFilter = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null

const nowTick = ref(Date.now())

async function load() {
  loading.value = true
  try {
    const res = await api.listAgents({
      search: search.value || undefined,
      status: statusFilter.value || undefined,
      page: page.value,
      page_size: pageSize,
      sort: 'last_seen',
    })
    agents.value = res.items
    total.value = res.total
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Gagal memuat daftar agent.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  const t = setInterval(() => (nowTick.value = Date.now()), 30000)
  onUnmounted(() => clearInterval(t))
})
useLiveRefresh(load)

watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    void load()
  }, 350)
})
watch(statusFilter, () => {
  page.value = 1
  void load()
})

function onPageChange(p: number) {
  page.value = p
  void load()
}

function sessionNo(a: AgentSummary): string {
  const no = a.current_session?.session_no
  return no !== undefined && no !== null ? `#${no}` : '—'
}

function bootId(a: AgentSummary): string {
  return a.current_session?.boot_id ?? '—'
}

function workerStatus(a: AgentSummary): string | null {
  return a.worker?.status ?? null
}

// ---------- Tambah Agent / pairing ----------
const showPairing = ref(false)
const plannedName = ref('')
const pairingPending = ref(false)
const pairingError = ref('')
const pairingResult = ref<{ code: string; expiresAt: string } | null>(null)
const copied = ref(false)

function openPairing() {
  plannedName.value = ''
  pairingError.value = ''
  pairingResult.value = null
  copied.value = false
  showPairing.value = true
}

async function createPairing() {
  if (pairingPending.value || !plannedName.value.trim()) return
  pairingPending.value = true
  pairingError.value = ''
  try {
    const res = await api.createPairing(plannedName.value.trim())
    pairingResult.value = { code: res.pairing_code, expiresAt: res.expires_at }
  } catch (e) {
    pairingError.value = e instanceof Error ? e.message : 'Gagal membuat kode pairing.'
  } finally {
    pairingPending.value = false
  }
}

async function copyCode() {
  if (!pairingResult.value) return
  try {
    await navigator.clipboard.writeText(pairingResult.value.code)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    /* clipboard tidak tersedia */
  }
}

// ---------- Cabut token ----------
const revokeTarget = ref<AgentSummary | null>(null)

async function doRevoke() {
  if (!revokeTarget.value) return
  await api.revokeAgent(revokeTarget.value.id)
  revokeTarget.value = null
  await load()
}

// ---------- Hapus agent permanen ----------
const deleteTarget = ref<AgentSummary | null>(null)

async function doDelete() {
  if (!deleteTarget.value) return
  await api.deleteAgent(deleteTarget.value.id)
  deleteTarget.value = null
  await load()
}
</script>

<template>
  <div>
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-white">Agent</h1>
        <p class="mt-0.5 text-sm text-ink-400">Kelola identitas, sesi, dan token seluruh agent terdaftar.</p>
      </div>
      <button v-if="isAdmin" class="btn-primary" @click="openPairing">
        <Plus class="h-4 w-4" />
        Tambah Agent
      </button>
    </div>

    <div class="panel">
      <div class="flex flex-wrap items-center gap-3 border-b border-ink-700 px-4 py-3">
        <div class="relative min-w-56 flex-1 sm:max-w-xs">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input v-model="search" type="text" placeholder="Cari nama atau ID agent…" class="field !pl-9" />
        </div>
        <select v-model="statusFilter" class="field !w-auto">
          <option value="">Semua Status</option>
          <option value="ONLINE">Online</option>
          <option value="UNREACHABLE">Tak Terjangkau</option>
        </select>
        <p class="ml-auto text-xs text-ink-400">Diurutkan dari heartbeat terakhir</p>
      </div>

      <p v-if="loadError" class="px-4 py-3 text-sm text-red-400">{{ loadError }}</p>

      <div class="overflow-x-auto">
        <table class="table-base min-w-[1080px]">
          <thead>
            <tr>
              <th>Nama Agent</th>
              <th>ID Agent</th>
              <th>Nama Worker</th>
              <th>Sesi Saat Ini</th>
              <th>Status Agent</th>
              <th>Versi Bridge</th>
              <th>Heartbeat Terakhir</th>
              <th>Boot ID</th>
              <th>Penggantian VM</th>
              <th class="text-right">Aksi</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading && agents.length === 0">
              <td colspan="10" class="py-10 text-center text-ink-400">Memuat daftar agent…</td>
            </tr>
            <tr v-else-if="agents.length === 0">
              <td colspan="10">
                <EmptyState message="Tidak ada agent yang cocok dengan filter. Tambahkan agent baru dengan tombol Tambah Agent." />
              </td>
            </tr>
            <tr v-for="a in agents" :key="a.id" :class="a.revoked_at ? 'opacity-50' : ''">
              <td>
                <NuxtLink :to="`/agents/${a.id}`" class="font-medium text-white hover:text-indigo-300">
                  {{ a.name }}
                </NuxtLink>
                <span
                  v-if="a.enrolled_via === 'self'"
                  class="ml-2 rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-300"
                  title="Agent ini mendaftar sendiri lewat dokumen agent.md"
                >DAFTAR MANDIRI</span>
                <span v-if="a.revoked_at" class="ml-2 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">TOKEN DICABUT</span>
              </td>
              <td class="font-mono text-xs text-ink-300">{{ a.id }}</td>
              <td>{{ a.worker_name || a.worker?.name || '—' }}</td>
              <td>{{ sessionNo(a) }}</td>
              <td><StatusChip :status="a.status" kind="agent" /></td>
              <td>{{ a.bridge_version || '—' }}</td>
              <td :title="fmtDateTime(a.last_seen_at)">{{ fmtRelative(a.last_seen_at, nowTick) }}</td>
              <td class="max-w-32 truncate font-mono text-xs text-ink-300" :title="bootId(a)">{{ bootId(a) }}</td>
              <td>{{ a.replacement_count ?? 0 }}×</td>
              <td>
                <div class="flex items-center justify-end gap-1">
                  <NuxtLink :to="`/agents/${a.id}`" class="btn-ghost !px-2 !py-1.5 text-xs" title="Lihat detail agent">
                    <Eye class="h-3.5 w-3.5" /> Detail
                  </NuxtLink>
                  <NuxtLink :to="`/commands?agent=${a.id}`" class="btn-ghost !px-2 !py-1.5 text-xs" title="Kirim perintah ke agent ini">
                    <Send class="h-3.5 w-3.5" /> Perintah
                  </NuxtLink>
                  <button
                    v-if="isAdmin"
                    class="btn-ghost !px-2 !py-1.5 text-xs !text-red-300 hover:!bg-red-500/10"
                    title="Cabut token agent"
                    :disabled="!!a.revoked_at"
                    @click="revokeTarget = a"
                  >
                    <Ban class="h-3.5 w-3.5" /> Cabut Token
                  </button>
                  <button
                    v-if="isAdmin"
                    class="btn-ghost !px-2 !py-1.5 text-xs !text-red-300 hover:!bg-red-500/10"
                    title="Hapus agent secara permanen"
                    @click="deleteTarget = a"
                  >
                    <Trash2 class="h-3.5 w-3.5" /> Hapus
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="px-4">
        <Pagination :page="page" :page-size="pageSize" :total="total" @change="onPageChange" />
      </div>
    </div>

    <!-- Dialog Tambah Agent -->
    <BaseModal v-if="showPairing" title="Tambah Agent — Kode Pairing" @close="showPairing = false">
      <template v-if="!pairingResult">
        <p class="text-sm leading-relaxed text-ink-300">
          Sistem akan membuat kode pairing sekali pakai untuk agent baru. Jalankan installer bridge
          di VM tujuan dengan kode ini; bridge akan menukar kode tersebut dengan identitas dan token
          permanen agent.
        </p>
        <div class="mt-4">
          <label for="planned-name" class="mb-1.5 block text-sm font-medium text-ink-300">Nama Agent yang Direncanakan</label>
          <input
            id="planned-name"
            v-model="plannedName"
            type="text"
            placeholder="cth. agent-jakarta-01"
            class="field"
            @keyup.enter="createPairing"
          />
        </div>
        <p v-if="pairingError" class="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{{ pairingError }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <button class="btn-ghost" @click="showPairing = false">Batal</button>
          <button class="btn-primary" :disabled="pairingPending || !plannedName.trim()" @click="createPairing">
            <LoaderCircle v-if="pairingPending" class="h-4 w-4 animate-spin" />
            {{ pairingPending ? 'Membuat…' : 'Buat Kode Pairing' }}
          </button>
        </div>
      </template>
      <template v-else>
        <p class="text-sm text-ink-300">
          Kode pairing untuk <span class="font-medium text-white">{{ plannedName }}</span> berhasil dibuat.
          Kode ini <span class="font-medium text-white">hanya ditampilkan sekali</span> dan berlaku sampai
          <span class="font-medium text-white">{{ fmtDateTime(pairingResult.expiresAt) }}</span>.
        </p>
        <div class="mt-4 flex items-center gap-2 rounded-lg bg-ink-850 px-3 py-3">
          <code class="flex-1 break-all font-mono text-sm text-emerald-300">{{ pairingResult.code }}</code>
          <button class="btn-ghost shrink-0 !px-2 !py-1.5 text-xs" @click="copyCode">
            <Check v-if="copied" class="h-3.5 w-3.5 text-emerald-400" />
            <Copy v-else class="h-3.5 w-3.5" />
            {{ copied ? 'Tersalin' : 'Salin' }}
          </button>
        </div>
        <div class="mt-4 rounded-lg border border-ink-700 px-3 py-2.5 text-xs leading-relaxed text-ink-400">
          <p class="font-medium text-ink-300">Cara memasang di VM agent:</p>
          <p class="mt-1">
            Jalankan installer bridge dengan variabel lingkungan
            <span class="font-mono text-ink-200">MUSE_PAIRING_CODE=&lt;kode di atas&gt;</span> dan
            <span class="font-mono text-ink-200">MUSE_SERVER_URL</span> mengarah ke server ini.
            Agent akan muncul pada daftar setelah heartbeat pertamanya diterima.
          </p>
        </div>
        <div class="mt-5 flex justify-end">
          <button class="btn-primary" @click="showPairing = false">Selesai</button>
        </div>
      </template>
    </BaseModal>

    <!-- Dialog Cabut Token -->
    <ConfirmDialog
      v-if="revokeTarget"
      title="Cabut Token Agent"
      :message="`Token agent ${revokeTarget.name} akan dicabut. Bridge pada VM tidak akan bisa lagi terhubung sampai agent dipasangkan ulang. Riwayat agent tidak dihapus. Lanjutkan?`"
      confirm-label="Ya, Cabut Token"
      :danger="true"
      :on-confirm="doRevoke"
      @close="revokeTarget = null"
    />

    <!-- Dialog Hapus Agent Permanen -->
    <ConfirmDialog
      v-if="deleteTarget"
      title="Hapus Agent Permanen"
      :message="`Agent ${deleteTarget.name} beserta SELURUH datanya — sesi, event, perintah, heartbeat, dan snapshot pool — akan dihapus permanen dan tidak bisa dikembalikan. Catatan penghapusan tetap tersimpan di log audit. Lanjutkan?`"
      confirm-label="Ya, Hapus Permanen"
      :danger="true"
      :on-confirm="doDelete"
      @close="deleteTarget = null"
    />
  </div>
</template>
