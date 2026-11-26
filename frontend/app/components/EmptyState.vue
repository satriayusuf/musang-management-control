<script setup lang="ts">
import { Inbox } from 'lucide-vue-next'

withDefaults(
  defineProps<{
    message?: string
  }>(),
  { message: 'Belum ada data untuk ditampilkan.' },
)
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
    <Inbox class="h-8 w-8 text-ink-600" />
    <p class="text-sm text-ink-400">{{ message }}</p>
    <slot />
  </div>
</template>
