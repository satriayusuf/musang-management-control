<script setup lang="ts">
import { X } from 'lucide-vue-next'

defineProps<{
  title: string
  wide?: boolean
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/70" @click="emit('close')" />
      <div
        class="panel relative max-h-[90vh] w-full overflow-y-auto shadow-2xl"
        :class="wide ? 'max-w-2xl' : 'max-w-md'"
        role="dialog"
        aria-modal="true"
      >
        <div class="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <h3 class="text-sm font-semibold text-white">{{ title }}</h3>
          <button
            class="rounded-md p-1 text-ink-400 transition-colors hover:bg-ink-800 hover:text-white"
            aria-label="Tutup"
            @click="emit('close')"
          >
            <X class="h-4 w-4" />
          </button>
        </div>
        <div class="px-5 py-4">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>
