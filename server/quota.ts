/**
 * Daily experience budget, stored in Workers KV.
 *
 * This replaces the old D1 usage ledger: the game has no database, and the only
 * thing that needs to survive a request is one number per day. The browser
 * replays its own conversation history (see `public/js/game.js`), so there is
 * nothing else to persist.
 *
 * ## KV is eventually consistent — read this before "fixing" it
 *
 * Workers KV has no atomic increment. A read-modify-write can lose updates when
 * two requests in different isolates race, and reads may be served from an edge
 * cache for up to 60 seconds. The budget is therefore a **soft** cap: a burst of
 * concurrent requests can spend a little more than the configured daily
 * budget, never dramatically less.
 *
 * That trade-off is accepted on purpose. The alternative — a Durable Object or
 * D1 — adds a second Cloudflare product to a demo game that otherwise needs
 * only Workers AI. The overshoot is bounded by the number of requests that can
 * pass the check within the KV propagation window, and each turn costs tens of
 * neurons, while the free account allowance is orders of magnitude larger.
 *
 * What KV *does* guarantee: the counter is global (not per-colo), it survives
 * isolate restarts, and it expires on its own.
 */

import { GAME_NEURON_DAILY_BUDGET, GAME_TOKEN_DAILY_BUDGET } from './limits.ts';

/** What the budget is counted in. */
export type QuotaUnit = 'neurons' | 'tokens';

/** One day's usage for one unit. */
export interface QuotaState {
  day: string;
  unit: QuotaUnit;
  /** Neurons or tokens spent so far today. */
  used: number;
  /** Successful completions today. */
  calls: number;
  /** Failed completions today (counted for observability, cost 0). */
  failed: number;
}

/** Daily budget for a unit. */
export const dailyBudgetFor = (unit: QuotaUnit): number =>
  unit === 'neurons' ? GAME_NEURON_DAILY_BUDGET : GAME_TOKEN_DAILY_BUDGET;

/**
 * KV key: one document per unit per day.
 *
 * Separate keys per unit mean switching provider mid-day does not corrupt the
 * ledger, and each document stays tiny (a single JSON object).
 */
export const quotaKey = (unit: QuotaUnit, day: string): string => `quota:${unit}:${day}`;

/** Keep yesterday around briefly for debugging; the game itself never looks back. */
const QUOTA_TTL_SECONDS = 60 * 60 * 24 * 7;

const emptyState = (unit: QuotaUnit, day: string): QuotaState => ({ day, unit, used: 0, calls: 0, failed: 0 });

const toCount = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

/** Read today's usage. Missing or corrupt documents read as zero. */
export const readQuota = async (kv: KVNamespace, unit: QuotaUnit, day: string): Promise<QuotaState> => {
  const raw = await kv.get(quotaKey(unit, day));
  if (raw === null) return emptyState(unit, day);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      day,
      unit,
      used: toCount(parsed.used),
      calls: toCount(parsed.calls),
      failed: toCount(parsed.failed)
    };
  } catch {
    // A truncated or hand-edited document must not brick the game for the day.
    return emptyState(unit, day);
  }
};

/**
 * Add one request's cost to today's ledger.
 *
 * The value is re-read immediately before writing: the window for a lost update
 * is then the duration of one KV round trip instead of the duration of the
 * model call (which is 1–3 seconds). This does not make the counter atomic, but
 * it keeps drift small in practice.
 */
export const addQuota = async (
  kv: KVNamespace,
  unit: QuotaUnit,
  day: string,
  delta: number,
  failed: boolean
): Promise<QuotaState> => {
  const current = await readQuota(kv, unit, day);
  const next: QuotaState = {
    day,
    unit,
    used: current.used + Math.max(0, delta),
    calls: current.calls + (failed ? 0 : 1),
    failed: current.failed + (failed ? 1 : 0)
  };
  await kv.put(quotaKey(unit, day), JSON.stringify(next), { expirationTtl: QUOTA_TTL_SECONDS });
  return next;
};

/** Convenience shape for `/api/health` and logs. */
export interface QuotaSnapshot {
  unit: QuotaUnit;
  budget: number;
  used: number;
  remaining: number;
  calls: number;
  failed: number;
}

export const snapshotQuota = (state: QuotaState, budget: number): QuotaSnapshot => ({
  unit: state.unit,
  budget,
  used: Math.round(state.used * 100) / 100,
  remaining: Math.max(0, Math.round((budget - state.used) * 100) / 100),
  calls: state.calls,
  failed: state.failed
});
