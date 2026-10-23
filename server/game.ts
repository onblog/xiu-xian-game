/**
 * The request handler: validate → budget → replay window → model.
 *
 * ## The browser owns the conversation
 *
 * There is no database. `public/js/game.js` keeps the last
 * `GAME_HISTORY_MAX_EXCHANGES` exchanges in memory and sends them with every
 * request; this module sanitizes and re-trims that array before it reaches the
 * model. That keeps the Worker stateless (apart from the daily KV counter) and
 * makes the deployment a single Worker plus one KV namespace.
 *
 * The trade-off is explicit: a reload starts a new run, and an attacker can
 * claim any history they like. Both are acceptable for a single-player
 * narrative game — the history only affects that player's own story, and the
 * replay window plus token budget cap what it can cost.
 *
 * ## Response shape
 *
 * One Server-Sent Event carrying the finished text:
 *
 * ```
 * data: {"text":"…","done":true}
 * ```
 *
 * The browser's typewriter does the progressive reveal. The upstream call is
 * non-streaming on purpose (see `ai.ts`), so this event is emitted once the
 * full completion exists — the same perceived latency as a real stream's first
 * token.
 *
 * ## Numbers stay with the model
 *
 * Age, lifespan and cultivation stage are computed by the model from the
 * prompt, exactly as the original agent did. Moving them into a code state
 * machine was tried and rejected: the narrative stopped advancing coherently.
 */

import {
  GAME_CONTEXT_TOKENS,
  GAME_HISTORY_MAX_EXCHANGES,
  GAME_HISTORY_SAFETY_TOKENS,
  GAME_MAX_TOKENS,
  GAME_MESSAGE_MAX_CHARS,
  GAME_MODEL,
  estimateNeurons,
  estimateTokens,
  utcDay
} from './limits.ts';
import { GAME_SYSTEM_PROMPT } from './prompt.ts';
import {
  chatCompletion,
  resolveProvider,
  type ChatMessage,
  type ChatResult,
  type Provider,
  type ProviderEnv
} from './ai.ts';
import {
  addQuota,
  dailyBudgetFor,
  readQuota,
  snapshotQuota,
  type QuotaSnapshot,
  type QuotaUnit
} from './quota.ts';

/** Everything the handler needs from the Worker environment. */
export interface GameEnv extends ProviderEnv {
  /** KV namespace holding the daily budget ledger. */
  QUOTA: KVNamespace;
  /** Local/CI stub (`GAME_STUB=1`): full budget path, no model call. */
  GAME_STUB?: string;
}

/** One player's step. `history` is whatever the browser sent; sanitized here. */
export interface GameRequestContext {
  /** The player's input: `是` for the opening, then `A` / `B` / `C`. */
  choice: string;
  /** Untrusted replay window from the browser. */
  history: unknown;
}

/** Handler result. Failures carry a player-facing message plus a log-only detail. */
export type GameOutcome =
  | { ok: true; text: string; provider: Provider; quota: QuotaSnapshot }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      detail?: string;
      quota?: QuotaSnapshot;
    };

/**
 * What the player may send.
 *
 * From prompt rule 6: the opening is `是`, after that only a bare A/B/C.
 */
export const isValidChoice = (choice: string): boolean => choice === '是' || /^[ABC]$/i.test(choice);

/**
 * Normalize a client-supplied history array.
 *
 * Never rejects: a malformed entry is dropped, an over-long message is
 * truncated, an over-long array keeps its newest messages. The goal is to make
 * the model call safe and bounded, not to punish a player for a stale tab.
 */
export const sanitizeHistory = (raw: unknown): ChatMessage[] => {
  if (!Array.isArray(raw)) return [];
  const window = raw.slice(-GAME_HISTORY_MAX_EXCHANGES * 2);
  const cleaned: ChatMessage[] = [];
  for (const item of window) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as { role?: unknown; content?: unknown };
    const role = record.role;
    const content = record.content;
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string') continue;
    const trimmed = content.trim();
    if (trimmed === '') continue;
    cleaned.push({ role, content: trimmed.slice(0, GAME_MESSAGE_MAX_CHARS) });
  }
  return cleaned;
};

/**
 * How many tokens the replay window may occupy.
 *
 * = context window − max output − system prompt − safety margin.
 *
 * The system prompt is a fixed cost (≈2200 tokens) and is subtracted first so a
 * long input cannot make the upstream drop it — that would destroy both the
 * persona and the output format the frontend depends on.
 */
export const historyBudgetTokens = (): number =>
  GAME_CONTEXT_TOKENS -
  GAME_MAX_TOKENS -
  GAME_HISTORY_SAFETY_TOKENS -
  estimateTokens(GAME_SYSTEM_PROMPT);

/**
 * Keep the newest messages that fit, in chronological order.
 *
 * Loading from the newest backwards is deliberate: the recent turns matter
 * most, and starting from the oldest would spend the budget on the opening
 * lines while dropping what just happened. Both caps apply — exchanges
 * (experience) and tokens (safety) — and the tighter one wins.
 *
 * Each message costs 4 extra tokens for role markers and separators.
 */
export const fitHistory = (messages: ChatMessage[], budgetTokens: number): ChatMessage[] => {
  const maxMessages = GAME_HISTORY_MAX_EXCHANGES * 2;
  const picked: ChatMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (picked.length >= maxMessages) break;
    const message = messages[i];
    if (message === undefined) continue;
    const cost = estimateTokens(message.content) + 4;
    if (used + cost > budgetTokens) break;
    used += cost;
    picked.push(message);
  }
  return picked.reverse();
};

/**
 * Assemble the model input.
 *
 * `messages[0]` is always the full original persona prompt (2929 characters),
 * verbatim — see the warning in `prompt.ts`.
 */
export const buildMessages = (history: ChatMessage[], choice: string): ChatMessage[] => [
  { role: 'system', content: GAME_SYSTEM_PROMPT },
  ...history,
  { role: 'user', content: choice }
];

/**
 * Wrap the finished text in one SSE event.
 *
 * The browser splits on newlines and parses every `data:` line, so the trailing
 * blank line is required. JSON encoding keeps newlines inside the payload intact.
 */
export const sseBody = (text: string): string =>
  `data: ${JSON.stringify({ text, done: true })}\n\n`;

/** Stub reply: same shape as a real one, for offline verification and CI. */
export const gameStubText = (choice: string): string =>
  [
    `✅ 上轮选择结果：选择${choice}，你在七玄门苦修，寿元正常扣除`,
    '🔥 当前状态：厉飞雨 | 22岁 | 剩余寿元78年 | 练气期1层',
    '⚡ 新阶段事件：韩立邀你同去墨大夫的药庐查看《长春功》残页（本地桩数据，未调用模型）',
    '📌 请选择：',
    'A. 随韩立前往，探明药庐底细',
    'B. 留在洞府苦修，暂避是非',
    'C. 先打探墨大夫的来历'
  ].join('\n');

const isStub = (env: GameEnv): boolean => env.GAME_STUB === '1';

/** Convert a completed call into the unit this provider is billed in. */
const costOf = (provider: Provider, result: ChatResult): number =>
  provider.kind === 'cloudflare'
    ? estimateNeurons(provider.model, result.inputTokens, result.outputTokens)
    : result.inputTokens + result.outputTokens;

/** Trim error text to something safe for a log line. */
const detailOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * Handle one player step.
 *
 * Order is fixed: provider → budget → replay window → model → ledger.
 * A request rejected by the budget never reaches the model and never changes
 * the ledger.
 */
export const playChoice = async (env: GameEnv, ctx: GameRequestContext): Promise<GameOutcome> => {
  if (!isValidChoice(ctx.choice)) {
    return { ok: false, status: 400, code: 'game-bad-choice', message: '选择无效，只能是 A / B / C。' };
  }

  const day = utcDay();

  // Resolve the provider first: it decides the billing unit of the daily budget.
  let provider: Provider;
  const resolution = resolveProvider(env);
  if (resolution.ok) {
    provider = resolution.provider;
  } else if (isStub(env)) {
    // Local development without any binding still exercises the whole path.
    provider = { kind: 'cloudflare', model: GAME_MODEL };
  } else {
    return {
      ok: false,
      status: 503,
      code: 'ai-not-configured',
      message: '服务端尚未配置大模型，请联系站长。',
      detail: resolution.reason
    };
  }

  const unit: QuotaUnit = provider.kind === 'cloudflare' ? 'neurons' : 'tokens';
  const budget = dailyBudgetFor(unit);

  // ---- The one and only gate: the site-wide daily experience budget ----
  const used = await readQuota(env.QUOTA, unit, day);
  if (used.used >= budget) {
    return {
      ok: false,
      status: 503,
      code: 'game-budget-exhausted',
      message: '今日体验额度已用完，明天再来吧。',
      quota: snapshotQuota(used, budget)
    };
  }

  const history = fitHistory(sanitizeHistory(ctx.history), historyBudgetTokens());
  const messages = buildMessages(history, ctx.choice);

  let result: ChatResult;
  try {
    if (isStub(env)) {
      const text = gameStubText(ctx.choice);
      result = {
        text,
        inputTokens: messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0),
        outputTokens: estimateTokens(text)
      };
    } else {
      result = await chatCompletion(env, provider, {
        messages,
        maxTokens: GAME_MAX_TOKENS,
        temperature: 0.9
      });
    }
  } catch (error) {
    // Count the attempt, charge nothing: a failed upstream call costs no tokens.
    await addQuota(env.QUOTA, unit, day, 0, true);
    return {
      ok: false,
      status: 502,
      code: 'game-ai-failed',
      message: '天机紊乱，请稍后重试。',
      // The upstream reason goes to the log only: it is noise to the player and
      // may leak internal URLs.
      detail: detailOf(error)
    };
  }

  if (result.text.trim() === '') {
    await addQuota(env.QUOTA, unit, day, 0, true);
    return { ok: false, status: 502, code: 'game-empty-reply', message: '天机紊乱，请稍后重试。', detail: 'empty completion' };
  }

  const state = await addQuota(env.QUOTA, unit, day, costOf(provider, result), false);
  return {
    ok: true,
    text: result.text,
    provider,
    quota: snapshotQuota(state, budget)
  };
};
