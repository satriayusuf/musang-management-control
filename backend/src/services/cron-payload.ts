// Payload validation for the generic cron.* command types (CONTRACT-7).
// Mirrors the bridge-side validator (bridge/src/cron.ts) — the server checks
// first so a malformed job never enters the queue; the bridge re-checks
// before scheduling it. Job commands run WITHOUT a shell on the agent VM,
// so shell metacharacters are rejected on both sides.

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are Sunday)
];

export function isValidCronName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name);
}

function isValidScheduleField(field: string, min: number, max: number): boolean {
  if (!field) return false;
  for (const part of field.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) return false;
    const [, base, rangeEnd, step] = m;
    if (base !== '*') {
      const v = Number(base);
      if (v < min || v > max) return false;
    }
    if (rangeEnd !== undefined) {
      const v = Number(rangeEnd);
      if (v < min || v > max) return false;
    }
    if (step !== undefined && Number(step) < 1) return false;
  }
  return true;
}

/** A standard 5-field numeric cron expression (no month/day names). */
export function isValidCronSchedule(schedule: unknown): schedule is string {
  if (typeof schedule !== 'string') return false;
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => isValidScheduleField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1]));
}

const SHELL_META_RE = /[;|&`$><\r\n\0]/;

export function isValidCronCommand(command: unknown): command is string {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  return trimmed.length >= 1 && trimmed.length <= 2000 && !SHELL_META_RE.test(command);
}

/** Returns an Indonesian error message, or null when the payload is valid. */
export function validateCronPayload(type: string, payload: Record<string, unknown> | null | undefined): string | null {
  const p = payload ?? {};
  if (type === 'cron.install') {
    if (!isValidCronName(p.name)) return 'Payload cron.install: name tidak valid (huruf/angka/titik/strip/garis bawah, maks 64 karakter).';
    if (!isValidCronSchedule(p.schedule)) return 'Payload cron.install: schedule harus ekspresi cron 5 kolom yang valid.';
    if (!isValidCronCommand(p.command)) return 'Payload cron.install: command harus teks 1–2000 karakter dalam satu baris, tanpa karakter shell (; | & ` $ > <).';
    return null;
  }
  if (type === 'cron.remove') {
    if (!isValidCronName(p.name)) return 'Payload cron.remove: name tidak valid.';
    return null;
  }
  return null;
}
