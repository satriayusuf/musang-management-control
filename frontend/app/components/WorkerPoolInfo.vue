<script setup lang="ts">
import { Waves, WifiOff } from 'lucide-vue-next'
import type { WorkerPoolInfo } from '~/lib/api'
import { fmtDateTime, fmtRelative, fmtHashrate, fmtNumber } from '~/lib/format'

defineProps<{
  /** Objek pool dari payload worker (CONTRACT-5 B6); komponen tidak merender apa pun bila null. */
  pool?: WorkerPoolInfo | null
  /** Penanda waktu untuk format relatif; bawaan memakai Date.now() di helper. */
  now?: number
}>()
</script>

<template>
  <div v-if="pool" class="rounded-xl border border-ink-700 bg-ink-850/60 px-3.5 py-3">
    <div class="flex flex-wrap items-center gap-2">
      <Waves class="h-4 w-4 shrink-0 text-sky-400" />
      <p class="text-xs font-semibold uppercase tracking-wide text-ink-300">Data Pool</p>
      <span
        v-if="pool.state === 'unknown'"
        class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-400 ring-1 ring-inset ring-amber-500/30"
        title="Pemeriksaan pool sedang tidak tersedia; data di bawah adalah hasil cek sukses terakhir"
      >
        <WifiOff class="h-3 w-3" />
        Cek pool tidak tersedia
      </span>
      <span v-if="pool.found === false" class="text-xs text-amber-300">
        Worker tidak terlihat di pool pada pemeriksaan terakhir.
      </span>
    </div>
    <dl class="mt-2.5 flex flex-wrap gap-x-7 gap-y-2.5">
      <div>
        <dt class="text-[11px] text-ink-400">Share Terakhir menurut Pool</dt>
        <dd class="text-sm font-medium text-white">
          {{ fmtRelative(pool.last_share_at, now) }}
          <span class="text-xs font-normal text-ink-400">{{ fmtDateTime(pool.last_share_at) }}</span>
        </dd>
      </div>
      <div>
        <dt class="text-[11px] text-ink-400">Share Diterima (menurut pool)</dt>
        <dd class="text-sm font-medium text-emerald-400">{{ fmtNumber(pool.accepted) }}</dd>
      </div>
      <div>
        <dt class="text-[11px] text-ink-400">Share Ditolak (menurut pool)</dt>
        <dd class="text-sm font-medium text-red-400">{{ fmtNumber(pool.rejected) }}</dd>
      </div>
      <div>
        <dt class="text-[11px] text-ink-400">Hashrate (menurut pool)</dt>
        <dd class="text-sm font-medium text-white">{{ fmtHashrate(pool.hashrate) }}</dd>
      </div>
      <div>
        <dt class="text-[11px] text-ink-400">Pemeriksaan Pool Terakhir</dt>
        <dd class="text-sm font-medium text-white">
          {{ fmtRelative(pool.fetched_at, now) }}
          <span class="text-xs font-normal text-ink-400">{{ fmtDateTime(pool.fetched_at) }}</span>
        </dd>
      </div>
    </dl>
    <p v-if="pool.state === 'unknown' && pool.fetch_error" class="mt-2 text-xs leading-relaxed text-ink-400">
      Kesalahan pemeriksaan terakhir: {{ pool.fetch_error }} — data di atas adalah hasil pemeriksaan sukses terakhir.
    </p>
  </div>
</template>
