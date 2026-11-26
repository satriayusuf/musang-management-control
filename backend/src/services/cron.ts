// Standard 5-field cron expressions (Phase 3, CONTRACT-3 §3) — a small,
// dependency-free, pure matcher.
//
// Fields: minute hour day-of-month month day-of-week. Supports `*`, lists
// (1,15), ranges (1-5), and steps (*/15, 9-17/2, 5/20). Day-of-week accepts
// 0-7 with both 0 and 7 meaning Sunday. When BOTH day-of-month and
// day-of-week are restricted, a date matches when EITHER matches (classic
// Vixie cron semantics); when only one is restricted, that one governs.
//
// Evaluation uses the SERVER'S LOCAL timezone (the Date getters below are
// local-time getters) — this is deliberate and documented in the README.

export interface CronSchedule {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>; // 0-6, 0 = Sunday
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  label: string,
  normalize?: (n: number) => number,
): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  const fail = (msg: string): never => {
    throw new Error(`Cron tidak valid pada kolom ${label}: ${msg}`);
  };
  if (raw.length === 0) fail('kolom kosong');
  for (const part of raw.split(',')) {
    const slash = part.split('/');
    if (slash.length > 2) fail(`"${part}" tidak dikenal`);
    const [base, stepRaw] = slash;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) fail(`langkah "${stepRaw}" bukan angka`);
      step = Number(stepRaw);
      if (step < 1) fail('langkah harus >= 1');
    }
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(base)) {
      lo = Number(base);
      // "5/20" means: start at 5, then every 20 up to the field maximum.
      hi = stepRaw !== undefined ? max : lo;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(base);
      if (!range) {
        throw new Error(`Cron tidak valid pada kolom ${label}: "${part}" tidak dikenal`);
      }
      lo = Number(range[1]);
      hi = Number(range[2]);
    }
    if (lo < min || lo > max || hi < min || hi > max) {
      fail(`nilai di luar rentang ${min}-${max}`);
    }
    if (hi < lo) fail(`rentang "${part}" terbalik`);
    for (let v = lo; v <= hi; v += step) {
      values.add(normalize ? normalize(v) : v);
    }
  }
  return { values, restricted: raw !== '*' };
}

/** Parse a 5-field cron expression. Throws Error (Bahasa Indonesia) when invalid. */
export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw new Error('Ekspresi cron wajib diisi (5 kolom: menit jam tanggal bulan hari)');
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Ekspresi cron harus terdiri dari 5 kolom, diterima ${fields.length}`);
  }
  const minute = parseField(fields[0], 0, 59, 'menit');
  const hour = parseField(fields[1], 0, 23, 'jam');
  const dom = parseField(fields[2], 1, 31, 'tanggal');
  const month = parseField(fields[3], 1, 12, 'bulan');
  const dow = parseField(fields[4], 0, 7, 'hari', (n) => (n === 7 ? 0 : n));
  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dom.values,
    month: month.values,
    dayOfWeek: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

/** True when `date` (server local time) matches the schedule. */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minute.has(date.getMinutes())) return false;
  if (!schedule.hour.has(date.getHours())) return false;
  if (!schedule.month.has(date.getMonth() + 1)) return false;
  const domMatch = schedule.dayOfMonth.has(date.getDate());
  const dowMatch = schedule.dayOfWeek.has(date.getDay());
  if (schedule.domRestricted && schedule.dowRestricted) return domMatch || dowMatch;
  if (schedule.domRestricted) return domMatch;
  if (schedule.dowRestricted) return dowMatch;
  return true;
}

/**
 * The next run strictly after `from`, at minute resolution (seconds are
 * truncated). Searches up to ~5 years ahead (leap-day schedules included);
 * returns null when nothing matches in that window.
 */
export function nextCronRun(schedule: CronSchedule, from: Date): Date | null {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const maxIterations = 366 * 24 * 60 * 5;
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatches(schedule, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/** Convenience: parse + next run in one call. Throws on invalid cron. */
export function computeNextRun(expression: string, from: Date): Date | null {
  return nextCronRun(parseCron(expression), from);
}
