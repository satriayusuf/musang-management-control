<script setup lang="ts">
import { ref } from 'vue'
import { TriangleAlert } from 'lucide-vue-next'

const props = defineProps<{
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
}>()

const emit = defineEmits<{ close: [] }>()
const pending = ref(false)
const error = ref('')

async function confirm() {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    await props.onConfirm()
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Terjadi kesalahan.'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <BaseModal :title="title" @close="emit('close')">
    <div class="flex gap-3">
      <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
        <TriangleAlert class="h-5 w-5" />
      </div>
      <p class="text-sm leading-relaxed text-ink-300">{{ message }}</p>
    </div>
    <p v-if="error" class="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{{ error }}</p>
    <div class="mt-5 flex justify-end gap-2">
      <button class="btn-ghost" :disabled="pending" @click="emit('close')">
        {{ cancelLabel ?? 'Batal' }}
      </button>
      <button
        :class="danger ? 'btn-danger' : 'btn-primary'"
        :disabled="pending"
        @click="confirm"
      >
        {{ pending ? 'Memproses…' : (confirmLabel ?? 'Konfirmasi') }}
      </button>
    </div>
  </BaseModal>
</template>
