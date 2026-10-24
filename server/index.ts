/**
 * Worker entry point.
 *
 * ## Routes
 *
 * - `POST /api/chat` — one player step; the success path answers with one SSE
 *   event (`data: {"text":"…","done":true}`) so the browser typewriter can run;
 * - `GET /api/health` — liveness plus provider and quota status (no secrets);
 * - everything else — served straight from Static Assets. `run_worker_first`
 *   only admits `/api/*`, so opening the game and loading its ~3.6 MB of media
 *   never invokes this Worker.
 *
 * ## Security boundary (the project is small, so it stays short)
 *
 * 1. **Same-origin check** — another site cannot spend the account's AI quota
 *    from a visitor's browser;
 * 2. **`cf-connecting-ip` is the only IP source** — never `x-forwarded-for`,
 *    which a client can forge;
 * 3. **No secrets in the repository** — Workers AI needs none, and the
 *    OpenAI-compatible key is a Worker secret, read from `env` only.
 *
 * There is no rate limit by design; the only gate is the daily budget in
 * `quota.ts`.
 */

import { resolveProvider, type ProviderEnv } from './ai.ts';
import { playChoice, sseBody } from './game.ts';
import { utcDay } from './limits.ts';
import { dailyBudgetFor, readQuota, snapshotQuota, type QuotaUnit } from './quota.ts';

export interface Env extends ProviderEnv {
  /** KV namespace holding the daily budget ledger. */
  QUOTA: KVNamespace;
  /** Local/CI stub (`GAME_STUB=1`): full budget path, no model call. */
  GAME_STUB?: string;
}

/** Refuse absurd request bodies before parsing them. */
const MAX_BODY_BYTES = 64 * 1024;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });

const fail = (code: string, status: number, extra: Record<string, unknown> = {}): Response =>
  json({ ok: false, error: { code, ...extra } }, status);

/** Mask an IP for logs: `1.2.3.4` → `1.2.3.x`; IPv6 keeps three groups. */
const maskIp = (ip: string | null | undefined): string => {
  if (!ip) return 'unknown';
  if (ip.includes(':')) {
    const groups = ip.split(':').filter((part) => part !== '');
    return `${groups.slice(0, 3).join(':')}::x`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return 'unknown';
  return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
};

/** The client IP, only ever from the header Cloudflare injects. */
const clientIp = (request: Request): string | null => {
  const value = (request.headers.get('cf-connecting-ip') ?? '').trim();
  return value === '' ? null : value;
};

/**
 * Same-origin check.
 *
 * A request without an `Origin` header is allowed (some same-origin contexts
 * omit it); if the header is present it must match the request host. This is
 * what stops another site from burning the AI budget from a visitor's browser.
 */
const sameOrigin = (request: Request, url: URL): boolean => {
  const origin = request.headers.get('origin');
  if (origin === null || origin === '') return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
};

/** Client-generated session id, used for log correlation only. */
const SESSION_ID_RE = /^[a-z0-9]{8,64}$/i;

/**
 * `POST /api/chat` — the player takes one step.
 *
 * Body: `{ sessionId?, choice, history?, turn? }`.
 * Success: SSE. Rejected by the budget, by the provider, or by validation:
 * a JSON envelope `{ ok:false, error:{ code, message } }` that the frontend
 * prints in the story area (see `showRetry` in `public/js/game.js`).
 */
const handleChat = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (!sameOrigin(request, url)) {
    console.warn(JSON.stringify({ event: 'origin.blocked', origin: request.headers.get('origin') }));
    return fail('origin-not-allowed', 403);
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return fail('payload-too-large', 413);
  }

  let rawBody = '';
  try {
    rawBody = await request.text();
  } catch {
    /* An unreadable body is treated as empty and rejected by field validation. */
  }
  if (rawBody.length > MAX_BODY_BYTES) return fail('payload-too-large', 413);

  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed === 'object' && parsed !== null) payload = parsed as Record<string, unknown>;
  } catch {
    /* Empty or invalid JSON: field validation below rejects it. */
  }

  const choice = typeof payload.choice === 'string' ? payload.choice : '';
  const rawSession = typeof payload.sessionId === 'string' ? payload.sessionId : '';
  const session = SESSION_ID_RE.test(rawSession) ? rawSession.slice(0, 8) : 'unknown';
  const ip = maskIp(clientIp(request));

  const result = await playChoice(env, { choice, history: payload.history, turn: payload.turn });

  if (!result.ok) {
    const level = result.status >= 500 ? 'error' : 'warn';
    console[level](
      JSON.stringify({
        event: 'chat.failed',
        code: result.code,
        status: result.status,
        session,
        ip,
        quota: result.quota ?? null,
        // The upstream reason is logged, never returned to the player.
        detail: result.detail ?? ''
      })
    );
    return fail(result.code, result.status, {
      message: result.message,
      ...(result.quota === undefined ? {} : { quota: result.quota })
    });
  }

  console.log(
    JSON.stringify({
      event: 'chat.ok',
      session,
      ip,
      provider: result.provider.kind,
      model: result.provider.model,
      quota: result.quota
    })
  );

  return new Response(sseBody(result.text), {
    status: 200,
    headers: {
      // The frontend parses `data:` lines as Server-Sent Events.
      'content-type': 'text/event-stream; charset=utf-8',
      // Any cache layer would make the typewriter jump to the full text at once.
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff'
    }
  });
};

/**
 * `GET /api/health` — liveness plus the state an operator actually checks:
 * which provider is wired up and how much of today's budget is left.
 * Secrets are never included.
 */
const handleHealth = async (env: Env): Promise<Response> => {
  const stub = env.GAME_STUB === '1';
  const resolution = resolveProvider(env);
  if (!resolution.ok && !stub) {
    return json(
      { ok: false, error: { code: 'ai-not-configured', message: 'No model provider is configured.' } },
      503
    );
  }

  const provider = resolution.ok ? resolution.provider : { kind: 'cloudflare' as const, model: 'stub' };
  const unit: QuotaUnit = provider.kind === 'cloudflare' ? 'neurons' : 'tokens';
  const budget = dailyBudgetFor(unit);

  try {
    const state = await readQuota(env.QUOTA, unit, utcDay());
    return json({
      ok: true,
      data: {
        ai: { provider: provider.kind, model: provider.model, stub },
        quota: snapshotQuota(state, budget)
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: {
          code: 'quota-unreachable',
          message: error instanceof Error ? error.message.slice(0, 120) : ''
        }
      },
      503
    );
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/chat') {
        if (request.method !== 'POST') return fail('method-not-allowed', 405);
        return await handleChat(request, env, url);
      }
      if (url.pathname === '/api/health') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return fail('method-not-allowed', 405);
        return await handleHealth(env);
      }
      // Only /api/* reaches this script (see `run_worker_first` in wrangler.toml).
      return fail('not-found', 404);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'request.failed',
          path: url.pathname,
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
        })
      );
      return fail('internal-error', 500);
    }
  }
};
