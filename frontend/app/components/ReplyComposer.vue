<script setup lang="ts">
import type { BroadcastKind } from '~/lib/api'

// Fase 11 (CONTRACT-11): composer balasan/follow-up — dipakai untuk
// balasan per agent maupun follow-up broadcast. State teks + mode
// dipegang komponen ini; parent menerima (text, kind) lewat emit send.
const props = defineProps<{
  initialKind: BroadcastKind
  busy?: boolean
  error?: string
  submitLabel?: string
  placeholder?: string
}>()
const emit = defineEmits<{
  send: [text: string, kind: BroadcastKind]
  cancel: []
}>()

const text = ref('')
const kind = ref<BroadcastKind>(props.initialKind)
</script>

<template>
  <div class="mt-2 rounded-lg border border-ink-700 bg-ink-900 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <button
        class="rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors"
        :class="
          kind === 'question'
            ? 'bg-indigo-600 text-white ring-indigo-500'
            : 'bg-ink-950 text-ink-300 ring-ink-700 hover:bg-ink-800'
        "
        @click="kind = 'question'"
      >
        Pertanyaan
      </button>
      <button
        class="rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors"
        :class="
          kind === 'instruction'
            ? 'bg-red-600 text-white ring-red-500'
            : 'bg-ink-950 text-ink-300 ring-ink-700 hover:bg-ink-800'
        "
        @click="kind = 'instruction'"
      >
        Instruksi (dieksekusi)
      </button>
      <span v-if="kind === 'instruction'" class="text-[11px] font-medium text-red-300">
        Akan dieksekusi oleh agent di VM-nya.
      </span>
    </div>
    <textarea
      v-model="text"
      rows="2"
      maxlength="2000"
      :placeholder="placeholder ?? 'Tulis balasan / update…'"
      class="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-indigo-500 focus:outline-none"
    />
    <p v-if="error" class="mt-2 text-sm text-red-400">{{ error }}</p>
    <div class="mt-2 flex items-center gap-2">
      <button
        class="rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        :class="kind === 'instruction' ? 'bg-red-600 hover:bg-red-500' : 'bg-indigo-600 hover:bg-indigo-500'"
        :disabled="busy || !text.trim()"
        @click="emit('send', text.trim(), kind)"
      >
        {{ busy ? 'Mengirim…' : (submitLabel ?? 'Kirim Balasan') }}
      </button>
      <button
        class="rounded-lg border border-ink-700 px-3 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:bg-ink-800"
        :disabled="busy"
        @click="emit('cancel')"
      >
        Batal
      </button>
    </div>
  </div>
</template>
