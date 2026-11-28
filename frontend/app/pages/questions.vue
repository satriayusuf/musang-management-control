<script setup lang="ts">
import { Trash2 } from 'lucide-vue-next'
import {
  api,
  type AgentSummary,
  type BroadcastKind,
  type QuestionBroadcastDetail,
  type QuestionBroadcastListItem,
} from '~/lib/api'
import { fmtDateTime } from '~/lib/format'
import { broadcastStatusLabel, questionKindLabel } from '~/lib/labels'

const auth = useAuthStore()

const agents = ref<AgentSummary[]>([])
const broadcasts = ref<QuestionBroadcastListItem[]>([])
const detail = ref<QuestionBroadcastDetail | null>(null)
const selectedId = ref('')

const questionText = ref('')
const mode = ref<BroadcastKind>('question')
const confirmInstruction = ref(false)
const selectAll = ref(true)
const selectedAgents = ref<string[]>([])
const sending = ref(false)
const sendError = ref('')
const sendOk = ref('')
const loading = ref(true)
const loadError = ref('')

async function loadAgents() {
  try {
    const res = await api.listAgents({ page: 1, page_size: 200 })
    agents.value = res.items
  } catch {
    /* daftar agent gagal dimuat; form tetap tampil */
  }
}

async function loadBroadcasts() {
  try {
    const res = await api.listQuestionBroadcasts({ page: 1, page_size: 20 })
    broadcasts.value = res.items
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Gagal memuat daftar pertanyaan.'
  } finally {
    loading.value = false
  }
}

async function openBroadcast(id: string) {
  selectedId.value = id
  try {
    detail.value = await api.getQuestionBroadcast(id)
  } catch {
    detail.value = null
  }
}

async function refresh() {
  await loadBroadcasts()
  if (selectedId.value) await openBroadcast(selectedId.value)
}

function targetAgentIds(): string[] {
  return selectAll.value ? agents.value.map((a) => a.id) : selectedAgents.value
}

function send() {
  sendError.value = ''
  sendOk.value = ''
  if (!questionText.value.trim()) {
    sendError.value = mode.value === 'instruction' ? 'Instruksi tidak boleh kosong.' : 'Pertanyaan tidak boleh kosong.'
    return
  }
  if (targetAgentIds().length === 0) {
    sendError.value = 'Pilih minimal satu agent.'
    return
  }
  // Instruksi DIEKSEKUSI oleh agent — wajib konfirmasi dulu (CONTRACT-9).
  if (mode.value === 'instruction') {
    confirmInstruction.value = true
    return
  }
  void doSend()
}

async function doSend() {
  confirmInstruction.value = false
  const question = questionText.value.trim()
  const agentIds = targetAgentIds()
  sending.value = true
  try {
    const res = await api.createQuestionBroadcast({ question, agent_ids: agentIds, kind: mode.value })
    sendOk.value =
      mode.value === 'instruction'
        ? `Instruksi terkirim ke ${res.question_count} agent dan akan dieksekusi. Laporan tiap agent muncul di bawah (maks. 30 menit).`
        : `Pertanyaan terkirim ke ${res.question_count} agent. Jawaban muncul di bawah saat agent menjawab (maks. 30 menit).`
    questionText.value = ''
    await loadBroadcasts()
    await openBroadcast(res.broadcast_id)
  } catch (e) {
    sendError.value = e instanceof Error ? e.message : 'Gagal mengirim.'
  } finally {
    sending.value = false
  }
}

const deleteTarget = ref<QuestionBroadcastListItem | null>(null)

function askDelete(item: QuestionBroadcastListItem) {
  deleteTarget.value = item
}

async function doDelete() {
  if (!deleteTarget.value) return
  const id = deleteTarget.value.broadcast_id
  await api.deleteQuestionBroadcast(id)
  if (selectedId.value === id) {
    selectedId.value = ''
    detail.value = null
  }
  deleteTarget.value = null
  await loadBroadcasts()
}

function statusChipClass(status: string): string {
  if (status === 'answered') return 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30'
  if (status === 'expired') return 'bg-zinc-500/10 text-zinc-300 ring-zinc-500/30'
  return 'bg-amber-500/10 text-amber-300 ring-amber-500/30'
}

onMounted(() => {
  void loadAgents()
  void loadBroadcasts()
})
useLiveRefresh(refresh)
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold text-white">Tanya Agent</h1>
      <p class="mt-1 text-sm text-ink-400">
        Satu pesan dikirim ke semua agent yang dipilih. Mode <b>Pertanyaan</b>: agent menjawab dengan
        menyelidiki (hanya-baca), tidak mengubah apa pun di VM. Mode <b>Instruksi</b>: agent
        MENGEKSEKUSI isi pesan di VM-nya dan melaporkan hasilnya. Keduanya kedaluwarsa setelah 30 menit.
      </p>
    </div>

    <!-- Form pertanyaan / instruksi -->
    <section class="rounded-xl border border-ink-700 bg-ink-900 p-5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium text-ink-200">Mode:</span>
        <button
          class="rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors disabled:opacity-50"
          :class="
            mode === 'question'
              ? 'bg-indigo-600 text-white ring-indigo-500'
              : 'bg-ink-950 text-ink-300 ring-ink-700 hover:bg-ink-800'
          "
          :disabled="!auth.canOperate"
          @click="mode = 'question'"
        >
          Pertanyaan
        </button>
        <button
          class="rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors disabled:opacity-50"
          :class="
            mode === 'instruction'
              ? 'bg-red-600 text-white ring-red-500'
              : 'bg-ink-950 text-ink-300 ring-ink-700 hover:bg-ink-800'
          "
          :disabled="!auth.canOperate"
          @click="mode = 'instruction'"
        >
          Instruksi (dieksekusi)
        </button>
      </div>
      <p v-if="mode === 'instruction'" class="mt-2 text-xs font-medium text-red-300">
        Mode instruksi: isi pesan akan DIEKSEKUSI oleh setiap agent yang dipilih di VM-nya masing-masing,
        lalu hasilnya dilaporkan ke sini. Pastikan isinya memang perintah yang ingin dijalankan.
      </p>
      <label class="mt-3 block text-sm font-medium text-ink-200" for="question-text">
        {{ mode === 'instruction' ? 'Instruksi' : 'Pertanyaan' }}
      </label>
      <textarea
        id="question-text"
        v-model="questionText"
        rows="3"
        maxlength="2000"
        :disabled="!auth.canOperate"
        :placeholder="
          mode === 'instruction'
            ? 'Contoh: Ubah interval poll hook watchdog jadi 60 detik'
            : 'Contoh: Berapa hashrate kamu sekarang, dan kapan share terakhir kamu diterima pool?'
        "
        class="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
      />
      <div class="mt-3 flex flex-wrap items-center gap-4">
        <label class="inline-flex items-center gap-2 text-sm text-ink-200">
          <input v-model="selectAll" type="checkbox" :disabled="!auth.canOperate" class="h-4 w-4 rounded" />
          Semua agent ({{ agents.length }})
        </label>
        <button
          class="rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          :class="mode === 'instruction' ? 'bg-red-600 hover:bg-red-500' : 'bg-indigo-600 hover:bg-indigo-500'"
          :disabled="sending || !auth.canOperate"
          @click="send"
        >
          {{ sending ? 'Mengirim…' : mode === 'instruction' ? 'Kirim Instruksi' : 'Kirim Pertanyaan' }}
        </button>
        <span v-if="!auth.canOperate" class="text-xs text-ink-500">Peran Anda hanya dapat melihat.</span>
      </div>
      <div v-if="!selectAll" class="mt-3 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-ink-700 p-3">
        <label
          v-for="a in agents"
          :key="a.id"
          class="flex items-center gap-2 rounded px-2 py-1 text-sm text-ink-200 hover:bg-ink-800/60"
        >
          <input v-model="selectedAgents" type="checkbox" :value="a.id" class="h-4 w-4 rounded" />
          <span class="truncate">{{ a.name }}</span>
          <span v-if="a.worker_name" class="truncate text-xs text-ink-500">{{ a.worker_name }}</span>
        </label>
        <p v-if="agents.length === 0" class="px-2 py-1 text-sm text-ink-500">Belum ada agent terdaftar.</p>
      </div>
      <p v-if="sendError" class="mt-3 text-sm text-red-400">{{ sendError }}</p>
      <p v-if="sendOk" class="mt-3 text-sm text-emerald-400">{{ sendOk }}</p>
    </section>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <!-- Daftar broadcast -->
      <section class="rounded-xl border border-ink-700 bg-ink-900 p-5">
        <h2 class="text-sm font-semibold text-white">Pertanyaan Terakhir</h2>
        <p v-if="loading" class="mt-3 text-sm text-ink-400">Memuat…</p>
        <p v-else-if="loadError" class="mt-3 text-sm text-red-400">{{ loadError }}</p>
        <p v-else-if="broadcasts.length === 0" class="mt-3 text-sm text-ink-400">Belum ada pertanyaan terkirim.</p>
        <ul v-else class="mt-3 space-y-2">
          <li v-for="b in broadcasts" :key="b.broadcast_id" class="flex items-stretch gap-1.5">
            <button
              class="min-w-0 flex-1 rounded-lg border px-3 py-2 text-left transition-colors"
              :class="
                b.broadcast_id === selectedId
                  ? 'border-indigo-500/60 bg-ink-800'
                  : 'border-ink-700 bg-ink-950 hover:bg-ink-800/60'
              "
              @click="openBroadcast(b.broadcast_id)"
            >
              <span class="flex items-center gap-2">
                <span
                  class="inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset"
                  :class="
                    b.kind === 'instruction'
                      ? 'bg-red-500/10 text-red-300 ring-red-500/30'
                      : 'bg-zinc-500/10 text-zinc-300 ring-zinc-500/30'
                  "
                >
                  {{ questionKindLabel(b.kind) }}
                </span>
                <span class="block min-w-0 truncate text-sm text-ink-100">{{ b.question }}</span>
              </span>
              <span class="mt-1 block text-xs text-ink-500">
                {{ fmtDateTime(b.asked_at) }} · {{ b.summary.answered }}/{{ b.summary.total }}
                {{ b.kind === 'instruction' ? 'dikerjakan' : 'dijawab' }}
              </span>
            </button>
            <button
              v-if="auth.canOperate"
              class="shrink-0 rounded-lg border border-ink-700 bg-ink-950 px-2 text-ink-400 transition-colors hover:border-red-500/50 hover:text-red-400"
              title="Hapus pertanyaan ini"
              @click="askDelete(b)"
            >
              <Trash2 class="h-4 w-4" />
            </button>
          </li>
        </ul>
      </section>

      <!-- Detail broadcast -->
      <section class="rounded-xl border border-ink-700 bg-ink-900 p-5">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold text-white">Jawaban</h2>
          <button
            v-if="detail && auth.canOperate"
            class="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:border-red-500/50 hover:text-red-400"
            @click="
              askDelete({
                broadcast_id: detail.broadcast_id,
                kind: detail.kind,
                question: detail.question,
                asked_by: detail.asked_by,
                asked_at: detail.asked_at,
                summary: detail.summary,
              })
            "
          >
            <Trash2 class="h-3.5 w-3.5" />
            Hapus
          </button>
        </div>
        <p v-if="!detail" class="mt-3 text-sm text-ink-400">Pilih pertanyaan di kiri untuk melihat jawaban tiap agent.</p>
        <template v-else>
          <p class="mt-3 flex items-center gap-2">
            <span
              class="inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset"
              :class="
                detail.kind === 'instruction'
                  ? 'bg-red-500/10 text-red-300 ring-red-500/30'
                  : 'bg-zinc-500/10 text-zinc-300 ring-zinc-500/30'
              "
            >
              {{ questionKindLabel(detail.kind) }}
            </span>
            <span class="text-sm font-medium text-ink-100">{{ detail.question }}</span>
          </p>
          <p class="mt-1 text-xs text-ink-500">
            {{ detail.asked_by }} · {{ fmtDateTime(detail.asked_at) }} ·
            {{ detail.summary.answered }}/{{ detail.summary.total }}
            {{ detail.kind === 'instruction' ? 'dikerjakan' : 'dijawab' }} ·
            {{ detail.summary.queued }} menunggu · {{ detail.summary.expired }}
            {{ detail.kind === 'instruction' ? 'tidak dikerjakan' : 'tidak menjawab' }}
          </p>
          <ul class="mt-4 space-y-3">
            <li
              v-for="item in detail.items"
              :key="item.id"
              class="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5"
            >
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-sm font-medium text-ink-100">
                  {{ item.agent_name ?? item.agent_id }}
                </span>
                <span
                  class="inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset"
                  :class="statusChipClass(item.status)"
                >
                  {{ broadcastStatusLabel(detail.kind, item.status) }}
                </span>
              </div>
              <p v-if="item.status === 'answered'" class="mt-1.5 whitespace-pre-wrap text-sm text-ink-200">
                {{ item.answer }}
              </p>
              <p v-if="item.answered_at" class="mt-1 text-xs text-ink-500">
                {{ detail.kind === 'instruction' ? 'Dilaporkan' : 'Dijawab' }} {{ fmtDateTime(item.answered_at) }}
              </p>
            </li>
          </ul>
        </template>
      </section>
    </div>

    <ConfirmDialog
      v-if="deleteTarget"
      title="Hapus Pertanyaan"
      :message="`Hapus “${deleteTarget.question}” beserta semua jawaban/laporannya? Tindakan ini permanen dan tidak bisa dibatalkan.`"
      confirm-label="Hapus"
      danger
      :on-confirm="doDelete"
      @close="deleteTarget = null"
    />

    <ConfirmDialog
      v-if="confirmInstruction"
      title="Kirim Instruksi?"
      :message="`Instruksi “${questionText.trim()}” akan DIEKSEKUSI oleh ${targetAgentIds().length} agent di VM mereka masing-masing. Lanjutkan?`"
      confirm-label="Kirim & Eksekusi"
      danger
      :on-confirm="doSend"
      @close="confirmInstruction = false"
    />
  </div>
</template>
