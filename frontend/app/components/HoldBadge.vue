<script setup lang="ts">
import { PauseCircle } from 'lucide-vue-next'

defineProps<{
  /** Tampilkan badge hanya bila penahanan aktif; komponen ini tidak merender apa pun bila nonaktif. */
  active?: boolean | null
}>()
</script>

<template>
  <span
    v-if="active"
    class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-400 ring-1 ring-inset ring-amber-500/30"
    title="Pemulihan otomatis sedang ditahan untuk worker ini"
  >
    <PauseCircle class="h-3 w-3" />
    Ditahan
  </span>
</template>
