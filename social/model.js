import { createHash } from 'node:crypto';

export const MEDIA_TYPE = 'application/vnd.opengym.social+json';
export const hash = x => createHash('sha256').update(x).digest('hex').slice(0, 32);
export const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const text = (v, max = 160) => typeof v === 'string' ? v.slice(0, max) : '';
const number = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e9 ? v : null;
const list = v => Array.isArray(v) ? v : [];
export const escape = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A second allowlist at the public service boundary, including for foreign workout records. */
export function cleanWorkout(w) {
  if (!w || typeof w.id !== 'string' || !w.id || w.id.length > 80) fail(400, 'Invalid workout');
  const set = s => {
    const out = {};
    for (const k of ['weight', 'reps', 'seconds', 'minutes', 'speedKmh', 'incline', 'rpe', 'rir']) if (number(s?.[k]) !== null) out[k] = s[k];
    if (s?.warmup === true) out.warmup = true;
    return out;
  };
  const exercises = list(w.exercises).slice(0, 60).map(e => ({ id: text(e?.id, 40), name: text(e?.name, 80), sets: list(e?.sets).slice(0, 50).map(s => {
    // Nested sides are limited to one level, regardless of what a remote server supplies.
    const out = set({ ...s, sides: undefined });
    if (s?.sides) out.sides = { left: set({ ...s.sides.left, sides: undefined }), right: set({ ...s.sides.right, sides: undefined }) };
    return out;
  }) }));
  return {
    id: w.id, name: text(w.name, 80), date: text(w.date, 10), unit: w.unit === 'lb' ? 'lb' : 'kg',
    durationMin: number(w.durationMin),
    totals: Object.fromEntries(['exercises', 'sets', 'reps', 'volume'].map(k => [k, number(w.totals?.[k]) || 0])),
    exercises, records: list(w.records).slice(0, 60).map(r => ({ id: text(r?.id, 40), name: text(r?.name, 80) })),
  };
}

export function originOf(value) { try { return new URL(value).origin; } catch { return null; } }
