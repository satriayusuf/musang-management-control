<script setup lang="ts">
import { computed } from 'vue'

export interface ChartPoint {
  t: string
  v: number
}

const props = withDefaults(
  defineProps<{
    points: ChartPoint[]
    color?: string
    height?: number
    unit?: string
  }>(),
  { color: '#818cf8', height: 120, unit: '' },
)

const W = 640

const prepared = computed(() => {
  const pts = (props.points ?? []).filter((p) => typeof p.v === 'number' && !Number.isNaN(p.v))
  if (pts.length === 0) return null
  const values = pts.map((p) => p.v)
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (min === max) {
    min -= 1
    max += 1
  }
  const pad = (max - min) * 0.1
  min -= pad
  max += pad
  const h = props.height
  const stepX = pts.length > 1 ? W / (pts.length - 1) : 0
  const coords = pts.map((p, i) => {
    const x = pts.length > 1 ? i * stepX : W / 2
    const y = h - ((p.v - min) / (max - min)) * h
    return [x, y] as const
  })
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} ${W},${h} 0,${h}`
  return {
    line,
    area,
    min: Math.min(...values),
    max: Math.max(...values),
    first: pts[0],
    last: pts[pts.length - 1],
  }
})

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}
</script>

<template>
  <div>
    <div v-if="!prepared" class="flex items-center justify-center py-8 text-sm text-ink-400">
      Tidak ada data deret waktu pada rentang ini.
    </div>
    <template v-else>
      <svg
        :viewBox="`0 0 ${W} ${height}`"
        class="w-full"
        :style="{ height: `${height}px` }"
        preserveAspectRatio="none"
        role="img"
      >
        <polygon :points="prepared.area" :fill="color" opacity="0.12" />
        <polyline
          :points="prepared.line"
          fill="none"
          :stroke="color"
          stroke-width="1.8"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      <div class="mt-1.5 flex items-center justify-between text-[11px] text-ink-400">
        <span>{{ shortTime(prepared.first.t) }}</span>
        <span>
          Min {{ prepared.min }}{{ unit }} · Maks {{ prepared.max }}{{ unit }} · Terakhir
          {{ prepared.last.v }}{{ unit }}
        </span>
        <span>{{ shortTime(prepared.last.t) }}</span>
      </div>
    </template>
  </div>
</template>
