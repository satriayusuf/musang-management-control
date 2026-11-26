<script setup lang="ts">
import { Plus, LoaderCircle, RefreshCw, KeyRound, Info } from 'lucide-vue-next'
import { api, type UserInfo } from '~/lib/api'
import { fmtDateTime } from '~/lib/format'
import { USER_ROLES, userRoleLabel } from '~/lib/labels'

const auth = useAuthStore()
const isAdmin = computed(() => auth.isAdmin)

const users = ref<UserInfo[]>([])
const loading = ref(true)
const loadError = ref('')
const actionNote = ref('')
const actionError = ref('')

async function load() {
  loading.value = true
  try {
    users.value = await api.listUsers()
    loadError.value = ''
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Gagal memuat daftar pengguna.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (isAdmin.value) void load()
  else loading.value = false
})

function isSelf(u: UserInfo): boolean {
  return !!auth.email && u.email.toLowerCase() === auth.email.toLowerCase()
}

// ---------- Buat pengguna ----------
const createOpen = ref(false)
const createSaving = ref(false)
const createError = ref('')
const createForm = ref({ email: '', password: '', role: 'OPERATOR' })

function openCreate() {
  createForm.value = { email: '', password: '', role: 'OPERATOR' }
  createError.value = ''
  createOpen.value = true
}

async function doCreate() {
  if (createSaving.value) return
  createError.value = ''
  if (!createForm.value.email.trim()) {
    createError.value = 'Email wajib diisi.'
    return
  }
  if (createForm.value.password.length < 8) {
    createError.value = 'Kata sandi minimal 8 karakter.'
    return
  }
  createSaving.value = true
  try {
    await api.createUser({
      email: createForm.value.email.trim(),
      password: createForm.value.password,
      role: createForm.value.role,
    })
    createOpen.value = false
    actionNote.value = `Pengguna ${createForm.value.email.trim()} berhasil dibuat dengan peran ${userRoleLabel(createForm.value.role)}.`
    actionError.value = ''
    await load()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : 'Gagal membuat pengguna.'
  } finally {
    createSaving.value = false
  }
}

// ---------- Ubah peran ----------
const roleSavingId = ref('')
async function changeRole(u: UserInfo, role: string) {
  if (roleSavingId.value || role === u.role) return
  roleSavingId.value = u.id
  actionNote.value = ''
  actionError.value = ''
  try {
    const updated = await api.updateUser(u.id, { role })
    const idx = users.value.findIndex((x) => x.id === u.id)
    if (idx >= 0) users.value[idx] = { ...users.value[idx], ...updated, role }
    actionNote.value = `Peran ${u.email} diubah menjadi ${userRoleLabel(role)}.`
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : 'Gagal mengubah peran pengguna.'
    await load()
  } finally {
    roleSavingId.value = ''
  }
}

// ---------- Nonaktifkan / aktifkan ----------
const toggleTarget = ref<UserInfo | null>(null)
async function doToggleDisabled() {
  if (!toggleTarget.value) return
  const u = toggleTarget.value
  const updated = await api.updateUser(u.id, { disabled: !u.disabled })
  const idx = users.value.findIndex((x) => x.id === u.id)
  if (idx >= 0) users.value[idx] = { ...users.value[idx], ...updated, disabled: !u.disabled }
  actionNote.value = u.disabled
    ? `Pengguna ${u.email} berhasil diaktifkan kembali.`
    : `Pengguna ${u.email} berhasil dinonaktifkan dan tidak dapat masuk lagi.`
  actionError.value = ''
  toggleTarget.value = null
}

// ---------- Atur ulang kata sandi ----------
const resetTarget = ref<UserInfo | null>(null)
const resetPassword = ref('')
const resetSaving = ref(false)
const resetError = ref('')

function openReset(u: UserInfo) {
  resetTarget.value = u
  resetPassword.value = ''
  resetError.value = ''
}

async function doReset() {
  if (!resetTarget.value || resetSaving.value) return
  resetError.value = ''
  if (resetPassword.value.length < 8) {
    resetError.value = 'Kata sandi baru minimal 8 karakter.'
    return
  }
  resetSaving.value = true
  try {
    await api.resetUserPassword(resetTarget.value.id, resetPassword.value)
    actionNote.value = `Kata sandi ${resetTarget.value.email} berhasil diatur ulang.`
    actionError.value = ''
    resetTarget.value = null
  } catch (e) {
    resetError.value = e instanceof Error ? e.message : 'Gagal mengatur ulang kata sandi.'
  } finally {
    resetSaving.value = false
  }
}
</script>

<template>
  <div>
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-white">Pengguna</h1>
        <p class="mt-0.5 text-sm text-ink-400">
          Kelola akun yang dapat masuk ke dashboard beserta perannya. Hanya Administrator yang dapat
          membuka halaman ini; semua perubahan tercatat di log audit.
        </p>
      </div>
      <button v-if="isAdmin" class="btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" />
        Tambah Pengguna
      </button>
    </div>

    <div v-if="!isAdmin" class="panel flex items-start gap-3 p-5">
      <Info class="mt-0.5 h-5 w-5 shrink-0 text-ink-400" />
      <p class="text-sm leading-relaxed text-ink-300">
        Halaman ini hanya dapat diakses oleh <span class="font-medium text-white">Administrator</span>.
        Peran Anda saat ini adalah {{ auth.role ? userRoleLabel(auth.role) : '—' }}.
      </p>
    </div>

    <template v-else>
      <p v-if="actionNote" class="mb-5 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{{ actionNote }}</p>
      <p v-if="actionError" class="mb-5 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">{{ actionError }}</p>

      <section class="panel">
        <div class="flex flex-wrap items-center gap-3 border-b border-ink-700 px-4 py-3">
          <h2 class="text-sm font-semibold text-white">Daftar Pengguna</h2>
          <button class="btn-ghost ml-auto !px-2.5 !py-1.5 text-xs" :disabled="loading" @click="load">
            <RefreshCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" /> Segarkan
          </button>
        </div>

        <p v-if="loadError" class="px-4 py-3 text-sm text-red-400">{{ loadError }}</p>

        <div class="overflow-x-auto">
          <table class="table-base min-w-[820px]">
            <thead>
              <tr>
                <th>Email</th>
                <th>Peran</th>
                <th>Status</th>
                <th>Dibuat</th>
                <th class="text-right">Aksi</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading && users.length === 0">
                <td colspan="5" class="py-10 text-center text-ink-400">Memuat pengguna…</td>
              </tr>
              <tr v-else-if="users.length === 0">
                <td colspan="5"><EmptyState message="Belum ada pengguna terdaftar." /></td>
              </tr>
              <tr v-for="u in users" :key="u.id">
                <td>
                  <span class="font-medium text-white">{{ u.email }}</span>
                  <span
                    v-if="isSelf(u)"
                    class="ml-2 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-semibold text-ink-300"
                  >
                    ANDA
                  </span>
                </td>
                <td>
                  <select
                    class="field !w-auto !py-1.5 text-xs"
                    :value="u.role"
                    :disabled="roleSavingId === u.id || (isSelf(u) && u.role === 'ADMIN')"
                    :title="isSelf(u) && u.role === 'ADMIN' ? 'Anda tidak dapat menurunkan peran Anda sendiri.' : 'Ubah peran pengguna'"
                    @change="changeRole(u, ($event.target as HTMLSelectElement).value)"
                  >
                    <option v-for="r in USER_ROLES" :key="r.value" :value="r.value">{{ r.label }}</option>
                  </select>
                </td>
                <td>
                  <span
                    class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset"
                    :class="u.disabled ? 'bg-red-500/10 text-red-400 ring-red-500/30' : 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30'"
                  >
                    {{ u.disabled ? 'Nonaktif' : 'Aktif' }}
                  </span>
                </td>
                <td class="whitespace-nowrap text-xs">{{ fmtDateTime(u.created_at) }}</td>
                <td>
                  <div class="flex items-center justify-end gap-1.5">
                    <button class="btn-ghost !px-2.5 !py-1.5 text-xs" @click="openReset(u)">
                      <KeyRound class="h-3.5 w-3.5" /> Atur Ulang Sandi
                    </button>
                    <button
                      class="btn-ghost !px-2.5 !py-1.5 text-xs"
                      :class="u.disabled ? '' : '!text-red-300 hover:!bg-red-500/10'"
                      :disabled="isSelf(u)"
                      :title="isSelf(u) ? 'Anda tidak dapat menonaktifkan akun Anda sendiri.' : undefined"
                      @click="toggleTarget = u"
                    >
                      {{ u.disabled ? 'Aktifkan' : 'Nonaktifkan' }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel mt-5 p-5">
        <h2 class="text-sm font-semibold text-white">Tentang Peran</h2>
        <ul class="mt-3 space-y-2.5">
          <li v-for="r in USER_ROLES" :key="r.value" class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
            <span class="w-28 shrink-0 font-medium text-ink-100">{{ r.label }}</span>
            <span class="min-w-0 flex-1 text-xs leading-relaxed text-ink-400">{{ r.description }}</span>
          </li>
        </ul>
        <p class="mt-3 text-xs leading-relaxed text-ink-400">
          Pembatasan peran ditegakkan di server — menyembunyikan tombol di halaman ini hanya soal tampilan.
          Pengguna yang dinonaktifkan tidak dapat masuk sampai diaktifkan kembali.
        </p>
      </section>
    </template>

    <!-- Modal buat pengguna -->
    <BaseModal v-if="createOpen" title="Tambah Pengguna" @close="createOpen = false">
      <form class="space-y-4" @submit.prevent="doCreate">
        <div>
          <label for="user-email" class="mb-1.5 block text-sm font-medium text-ink-300">Email</label>
          <input id="user-email" v-model="createForm.email" type="email" class="field" placeholder="nama@contoh.id" autocomplete="off" required />
        </div>
        <div>
          <label for="user-password" class="mb-1.5 block text-sm font-medium text-ink-300">Kata Sandi Awal</label>
          <input
            id="user-password"
            v-model="createForm.password"
            type="password"
            class="field"
            placeholder="Minimal 8 karakter"
            autocomplete="new-password"
            required
          />
          <p class="mt-1 text-xs text-ink-400">Bagikan kata sandi ini secara aman; pengguna dapat diganti sandinya kapan pun oleh Administrator.</p>
        </div>
        <div>
          <label for="user-role" class="mb-1.5 block text-sm font-medium text-ink-300">Peran</label>
          <select id="user-role" v-model="createForm.role" class="field">
            <option v-for="r in USER_ROLES" :key="r.value" :value="r.value">{{ r.label }}</option>
          </select>
          <p class="mt-1 text-xs text-ink-400">{{ USER_ROLES.find((r) => r.value === createForm.role)?.description }}</p>
        </div>
        <p v-if="createError" class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{{ createError }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn-ghost" :disabled="createSaving" @click="createOpen = false">Batal</button>
          <button type="submit" class="btn-primary" :disabled="createSaving">
            <LoaderCircle v-if="createSaving" class="h-4 w-4 animate-spin" />
            {{ createSaving ? 'Membuat…' : 'Buat Pengguna' }}
          </button>
        </div>
      </form>
    </BaseModal>

    <!-- Modal atur ulang kata sandi -->
    <BaseModal v-if="resetTarget" title="Atur Ulang Kata Sandi" @close="resetTarget = null">
      <form class="space-y-4" @submit.prevent="doReset">
        <p class="text-sm leading-relaxed text-ink-300">
          Atur kata sandi baru untuk <span class="font-medium text-white">{{ resetTarget.email }}</span>.
          Sesi yang sedang berjalan tidak otomatis berakhir, tetapi kata sandi lama tidak berlaku lagi untuk masuk berikutnya.
        </p>
        <div>
          <label for="reset-password" class="mb-1.5 block text-sm font-medium text-ink-300">Kata Sandi Baru</label>
          <input
            id="reset-password"
            v-model="resetPassword"
            type="password"
            class="field"
            placeholder="Minimal 8 karakter"
            autocomplete="new-password"
            required
          />
        </div>
        <p v-if="resetError" class="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{{ resetError }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn-ghost" :disabled="resetSaving" @click="resetTarget = null">Batal</button>
          <button type="submit" class="btn-primary" :disabled="resetSaving">
            <LoaderCircle v-if="resetSaving" class="h-4 w-4 animate-spin" />
            {{ resetSaving ? 'Menyimpan…' : 'Simpan Kata Sandi Baru' }}
          </button>
        </div>
      </form>
    </BaseModal>

    <!-- Konfirmasi nonaktifkan / aktifkan -->
    <ConfirmDialog
      v-if="toggleTarget"
      :title="toggleTarget.disabled ? 'Aktifkan Pengguna' : 'Nonaktifkan Pengguna'"
      :message="
        toggleTarget.disabled
          ? `Pengguna ${toggleTarget.email} akan diaktifkan kembali dan dapat masuk ke dashboard. Lanjutkan?`
          : `Pengguna ${toggleTarget.email} akan dinonaktifkan dan tidak dapat masuk ke dashboard sampai diaktifkan kembali. Lanjutkan?`
      "
      :confirm-label="toggleTarget.disabled ? 'Ya, Aktifkan' : 'Ya, Nonaktifkan'"
      :danger="!toggleTarget.disabled"
      :on-confirm="doToggleDisabled"
      @close="toggleTarget = null"
    />
  </div>
</template>
