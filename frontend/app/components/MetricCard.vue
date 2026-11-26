<script setup lang="ts">
import type { Component } from 'vue'

defineProps<{
  title: string
  value: string | number
  icon?: Component
  hint?: string
  accent?: string
}>()
</script>

<template>
  <div class="panel p-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="truncate text-xs font-medium uppercase tracking-wide text-ink-400">{{ title }}</p>
        <p class="mt-1.5 text-2xl font-semibold leading-none text-white">{{ value }}</p>
        <p v-if="hint" class="mt-2 text-xs text-ink-400">{{ hint }}</p>
      </div>
      <div
        v-if="icon"
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        :class="accent ?? 'bg-ink-800 text-ink-300'"
      >
        <component :is="icon" class="h-4.5 w-4.5" />
      </div>
    </div>
  </div>
</template>
