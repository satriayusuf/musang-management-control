<script setup lang="ts">
import { computed } from 'vue'
import {
  workerStatusLabel,
  agentStatusLabel,
  commandStatusLabel,
  combinedStatusLabel,
} from '~/lib/labels'

const props = defineProps<{
  /** Nilai status mentah dari API. */
  status?: string | null
  /** Jenis chip: worker (6 status), agent (ONLINE/UNREACHABLE), command (siklus perintah), combined (status gabungan CONTRACT-7). */
  kind?: 'worker' | 'agent' | 'command' | 'combined'
}>()

const WORKER_STYLES: Record<string, string> = {
  SEHAT: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30',
  WASPADA: 'bg-amber-500/10 text-amber-400 ring-amber-500/30',
  MATI: 'bg-red-500/10 text-red-400 ring-red-500/30',
  GAGAL_START: 'bg-orange-500/10 text-orange-400 ring-orange-500/30',
  TAK_TERJANGKAU: 'bg-zinc-500/10 text-zinc-400 ring-zinc-500/30',
  POOL_STALL: 'bg-violet-500/10 text-violet-400 ring-violet-500/30',
}

const AGENT_STYLES: Record<string, string> = {
  ONLINE: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30',
  UNREACHABLE: 'bg-red-500/10 text-red-400 ring-red-500/30',
}

const COMMAND_STYLES: Record<string, string> = {
  QUEUED: 'bg-sky-500/10 text-sky-400 ring-sky-500/30',
  SENT: 'bg-blue-500/10 text-blue-400 ring-blue-500/30',
  RUNNING: 'bg-amber-500/10 text-amber-400 ring-amber-500/30',
  SUCCEEDED: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30',
  FAILED: 'bg-red-500/10 text-red-400 ring-red-500/30',
  TIMED_OUT: 'bg-orange-500/10 text-orange-400 ring-orange-500/30',
  EXPIRED: 'bg-zinc-500/10 text-zinc-400 ring-zinc-500/30',
  WAITING_VM: 'bg-amber-500/10 text-amber-400 ring-amber-500/30',
  REJECTED: 'bg-orange-500/10 text-orange-400 ring-orange-500/30',
}

const COMBINED_STYLES: Record<string, string> = {
  JALAN: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30',
  PULIH: 'bg-sky-500/10 text-sky-400 ring-sky-500/30',
  MATI: 'bg-red-500/10 text-red-400 ring-red-500/30',
  TAK_TERJANGKAU: 'bg-zinc-500/10 text-zinc-400 ring-zinc-500/30',
}

const DOT_STYLES: Record<string, string> = {
  SEHAT: 'bg-emerald-400',
  ONLINE: 'bg-emerald-400',
  SUCCEEDED: 'bg-emerald-400',
  JALAN: 'bg-emerald-400',
  WASPADA: 'bg-amber-400',
  RUNNING: 'bg-amber-400',
  WAITING_VM: 'bg-amber-400',
  MATI: 'bg-red-400',
  UNREACHABLE: 'bg-red-400',
  FAILED: 'bg-red-400',
  GAGAL_START: 'bg-orange-400',
  TIMED_OUT: 'bg-orange-400',
  REJECTED: 'bg-orange-400',
  POOL_STALL: 'bg-violet-400',
  QUEUED: 'bg-sky-400',
  PULIH: 'bg-sky-400',
  SENT: 'bg-blue-400',
  TAK_TERJANGKAU: 'bg-zinc-400',
  EXPIRED: 'bg-zinc-400',
}

const label = computed(() => {
  if (!props.status) return '—'
  if (props.kind === 'agent') return agentStatusLabel(props.status)
  if (props.kind === 'command') return commandStatusLabel(props.status)
  if (props.kind === 'combined') return combinedStatusLabel(props.status)
  return workerStatusLabel(props.status)
})

const chipClass = computed(() => {
  const map =
    props.kind === 'agent'
      ? AGENT_STYLES
      : props.kind === 'command'
        ? COMMAND_STYLES
        : props.kind === 'combined'
          ? COMBINED_STYLES
          : WORKER_STYLES
  return map[props.status ?? ''] ?? 'bg-zinc-500/10 text-zinc-300 ring-zinc-500/30'
})

const dotClass = computed(() => DOT_STYLES[props.status ?? ''] ?? 'bg-zinc-400')
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset"
    :class="chipClass"
  >
    <span class="h-1.5 w-1.5 rounded-full" :class="dotClass" />
    {{ label }}
  </span>
</template>
