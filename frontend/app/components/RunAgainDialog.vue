<script setup lang="ts">
import { ref, computed } from 'vue'
import { Play, Info } from 'lucide-vue-next'
import { api, type WorkerInfo } from '~/lib/api'
import { fmtGiB } from '~/lib/format'
import { newIdempotencyKey } from '~/lib/format'

const props = defineProps<{
  worker: WorkerInfo
  agentName?: string
}>()

const emit = defineEmits<{ close: []; done: [] }>()

const pending = ref(false)
const error = ref('')
const queued = ref(false)

const blockedReason = computed(() => {
  if (props.worker.status === 'TAK_TERJANGKAU') {
    return 'Agent sedang tak terjangkau — heartbeat berhenti, sehingga perintah tidak dapat dikirim ke bridge saat ini.'
  }
  if (props.worker.status === 'GAGAL_START') {
    return 'Miner gagal start karena memori tersedia berada di bawah ambang minimum. Menjalankan ulang tidak akan menyelesaikan masalah memori.'
  }
  return ''
})

const blocked = computed(() => blockedReason.value !== '')

async function confirm() {
  if (pending.value || blocked.value) return
  pending.value = true
  error.value = ''
  try {
    await api.createWorkerCommand(props.worker.id, {
      type: 'miner.run',
      idempotency_key: newIdempotencyKey(),
      confirm: true,
    })
    queued.value = true
    emit('done')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Gagal membuat perintah.'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <BaseModal title="Run Lagi — Jalankan Miner" @close="emit('close')">
    <div class="space-y-3 text-sm">
      <div class="rounded-lg bg-ink-850 px-3 py-2.5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="font-medium text-white">{{ worker.name }}</p>
            <p v-if="agentName" class="text-xs text-ink-400">Agent: {{ agentName }}</p>
          </div>
          <StatusChip :status="worker.status" kind="worker" />
        </div>
        <p v-if="worker.status_reason" class="mt-2 text-xs text-ink-300">
          Alasan status: {{ worker.status_reason }}
        </p>
        <p v-if="worker.mem_available_gib !== undefined && worker.mem_available_gib !== null" class="mt-1 text-xs text-ink-400">
          Memori tersedia: {{ fmtGiB(worker.mem_available_gib) }}
        </p>
      </div>

      <div class="flex gap-2.5 text-ink-300">
        <Info class="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
        <p class="leading-relaxed">
          Perintah <span class="font-mono text-xs text-ink-100">miner.run</span> akan masuk ke antrian
          perintah. Bridge agent akan mengambilnya, menjalankan miner, lalu melaporkan hasilnya.
          Perintah hanya dinyatakan berhasil setelah status miner terverifikasi aktif pada
          heartbeat berikutnya.
        </p>
      </div>

      <p v-if="blocked" class="rounded-lg bg-red-500/10 px-3 py-2 text-red-300">
        {{ blockedReason }}
      </p>
      <p v-else-if="queued" class="rounded-lg bg-emerald-500/10 px-3 py-2 text-emerald-300">
        Perintah berhasil dibuat dan sedang menunggu diambil oleh agent. Pantau kemajuannya di Pusat Perintah.
      </p>
      <p v-if="error" class="rounded-lg bg-red-500/10 px-3 py-2 text-red-300">{{ error }}</p>
    </div>

    <div class="mt-5 flex justify-end gap-2">
      <button class="btn-ghost" :disabled="pending" @click="emit('close')">
        {{ queued ? 'Tutup' : 'Batal' }}
      </button>
      <button v-if="!queued" class="btn-primary" :disabled="pending || blocked" @click="confirm">
        <Play class="h-4 w-4" />
        {{ pending ? 'Mengirim…' : 'Ya, Jalankan Miner' }}
      </button>
    </div>
  </BaseModal>
</template>
