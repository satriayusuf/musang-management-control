<script setup lang="ts">
import { Bot, LoaderCircle } from 'lucide-vue-next'

definePageMeta({ layout: 'auth' })

const auth = useAuthStore()
const email = ref('')
const password = ref('')
const pending = ref(false)
const error = ref('')

async function submit() {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    await auth.login(email.value.trim(), password.value)
    await navigateTo('/')
  } catch (e) {
    error.value =
      e instanceof Error && e.message
        ? e.message
        : 'Gagal masuk. Periksa kembali email dan kata sandi Anda.'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="w-full max-w-sm">
    <div class="panel p-6 shadow-2xl">
      <div class="mb-6 flex flex-col items-center text-center">
        <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600">
          <Bot class="h-6 w-6 text-white" />
        </div>
        <h1 class="mt-3 text-lg font-semibold text-white">Muse Management Control</h1>
        <p class="mt-1 text-sm text-ink-400">Masuk untuk mengelola agent dan miner Anda.</p>
      </div>

      <form class="space-y-4" @submit.prevent="submit">
        <div>
          <label for="email" class="mb-1.5 block text-sm font-medium text-ink-300">Email</label>
          <input
            id="email"
            v-model="email"
            type="email"
            required
            autocomplete="email"
            placeholder="admin@contoh.id"
            class="field"
          />
        </div>
        <div>
          <label for="password" class="mb-1.5 block text-sm font-medium text-ink-300">Kata Sandi</label>
          <input
            id="password"
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
            placeholder="••••••••"
            class="field"
          />
        </div>

        <p v-if="error" class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{{ error }}</p>

        <button type="submit" class="btn-primary w-full justify-center" :disabled="pending">
          <LoaderCircle v-if="pending" class="h-4 w-4 animate-spin" />
          {{ pending ? 'Memproses…' : 'Masuk' }}
        </button>
      </form>
    </div>
    <p class="mt-4 text-center text-xs text-ink-400">
      Akses terbatas untuk administrator sistem.
    </p>
  </div>
</template>
