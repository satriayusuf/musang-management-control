<script setup lang="ts">
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'

const props = defineProps<{
  page: number
  pageSize: number
  total: number
}>()

const emit = defineEmits<{ change: [page: number] }>()

const totalPages = () => Math.max(1, Math.ceil(props.total / props.pageSize))
</script>

<template>
  <div v-if="total > 0" class="flex items-center justify-between gap-3 px-1 py-3 text-xs text-ink-400">
    <p>
      Menampilkan
      <span class="font-medium text-ink-100">{{ total === 0 ? 0 : (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, total) }}</span>
      dari <span class="font-medium text-ink-100">{{ total }}</span> data
    </p>
    <div class="flex items-center gap-1.5">
      <button
        class="btn-ghost !px-2 !py-1.5"
        :disabled="page <= 1"
        @click="emit('change', page - 1)"
      >
        <ChevronLeft class="h-3.5 w-3.5" />
        Sebelumnya
      </button>
      <span class="px-1">Halaman {{ page }} dari {{ totalPages() }}</span>
      <button
        class="btn-ghost !px-2 !py-1.5"
        :disabled="page >= totalPages()"
        @click="emit('change', page + 1)"
      >
        Berikutnya
        <ChevronRight class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
