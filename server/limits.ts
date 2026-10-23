/**
 * Shared limits and cost constants — the single source of truth for the Worker
 * and for `scripts/verify.mts`.
 *
 * ## One gate only: the site-wide daily experience budget
 *
 * There is **no per-IP, per-minute or per-session limit** anywhere in the
 * request path. The only gate is a site-wide daily budget that resets at UTC
 * midnight. The marginal cost of this game is entirely token-driven, so a
 * global budget is the only thing that actually protects the account; splitting
 * it per IP would reject the same player's second request while leaving the real
 * bill risk untouched.
 *
 * The unit depends on the provider:
 *
 * - Cloudflare Workers AI → **neurons** (the unit on the Workers AI bill);
 * - any OpenAI-compatible endpoint → **tokens** (input + output, as reported by
 *   the provider, or estimated locally when the provider omits usage).
 *
 * ## Why the Cloudflare budget is 4000 neurons
 *
 * A free Workers AI account gets 10,000 neurons/day, shared by every Worker on
 * that account. This game takes 4000 of it: a full 100-turn run costs ≈3560
 * neurons with a 15-exchange replay window, so one player can finish a
 * playthrough in a day and there is still headroom for a few more turns.
 * The remaining 6000 neurons stay available to the account owner's other
 * Workers.
 *
 * ## Why the replay window is 15 exchanges
 *
 * Every turn re-reads the whole replay window, so the window is the cost knob.
 * Measured per turn: the system prompt is ≈2522 tokens, each reply ≈229 chars
 * (≈174 tokens), each output ≈394 tokens. With a 15-exchange window the steady
 * state is ≈36 neurons/turn, and a 100-turn run totals ≈3560 neurons.
 *
 * The token budget is the safety cap: the window never exceeds it, and the
 * system prompt is subtracted first so that an over-long input can never push
 * the model into truncating the persona prompt.
 */

/** Site-wide daily experience budget for Workers AI, in neurons. */
export const GAME_NEURON_DAILY_BUDGET = 4000;

/** Site-wide daily experience budget for OpenAI-compatible providers, in tokens. */
export const GAME_TOKEN_DAILY_BUDGET = 600_000;

/** Maximum number of output tokens per turn. Output is the expensive side. */
export const GAME_MAX_TOKENS = 900;

/**
 * Context window used to size the replay budget (tokens).
 *
 * 32768 is the window of the default Workers AI model. It is also a safe floor
 * for every provider this game is likely to be pointed at, and the 15-exchange
 * window (≈5k tokens) is far below it either way.
 */
export const GAME_CONTEXT_TOKENS = 32_768;

/**
 * Safety margin for chat-template overhead and token estimation error (tokens).
 *
 * Replay budget = context window − max output − system prompt − this margin.
 * `estimateTokens()` is character-based, not a real tokenizer, so we would
 * rather carry one exchange less than let the upstream truncate the system
 * prompt.
 */
export const GAME_HISTORY_SAFETY_TOKENS = 800;

/**
 * How many recent Q&A exchanges the browser replays to the Worker.
 *
 * This is the experience-side cap; the token budget above is the safety-side
 * cap. The browser trims its local history to the same number (see
 * `MAX_HISTORY_MESSAGES` in `public/js/game.js`), and the server trims again —
 * never trust a client-provided array to be small.
 */
export const GAME_HISTORY_MAX_EXCHANGES = 15;

/** Hard per-message character cap for client-supplied history (abuse guard). */
export const GAME_MESSAGE_MAX_CHARS = 4000;

/**
 * Default Workers AI model.
 *
 * Must be available on the Workers Free plan. `deepseek-*` and `gpt-oss-*`
 * currently answer `5035 Model is not available on the Workers Free plan`.
 *
 * Note: Qwen tends to number choices `1./2./3.` instead of `A./B./C.`; the
 * frontend only accepts `^[A-C]\.`, so the prompt keeps an explicit
 * "must start with the capital letters A. B. C." constraint.
 */
export const GAME_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

/** Default model for OpenAI-compatible endpoints when `LLM_MODEL` is unset. */
export const GAME_DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/**
 * Neuron rates (neurons per million tokens) published for the supported
 * Workers AI models.
 *
 * Rates differ a lot between models, so converting usage to neurons must always
 * carry the model id. Using one global rate once under-counted the real cost by
 * ~3x, which let the budget gate believe it still had room while the account
 * quota was already exhausted — that breaks every other Worker on the account.
 */
export const NEURON_RATES: Record<string, { input: number; output: number }> = {
  '@cf/qwen/qwen3-30b-a3b-fp8': { input: 4625, output: 30475 },
  '@cf/meta/llama-3.1-8b-instruct-fp8': { input: 13778, output: 26128 },
  '@cf/meta/llama-3.2-3b-instruct': { input: 4625, output: 30475 }
};

/** Most expensive known rate; used as the fallback for unknown model ids. */
const mostExpensiveRate = (): { input: number; output: number } =>
  Object.values(NEURON_RATES).reduce((worst, rate) =>
    rate.input + rate.output > worst.input + worst.output ? rate : worst
  );

/**
 * Convert one call's usage into neurons.
 *
 * The model id is mandatory because rates vary by model. Unknown models fall
 * back to the **most expensive** known rate: over-estimating stops the game
 * early, under-estimating burns the account-level quota shared with other
 * Workers.
 */
export const estimateNeurons = (model: string, inputTokens: unknown, outputTokens: unknown): number => {
  const rate = NEURON_RATES[model] ?? mostExpensiveRate();
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  return (input * rate.input + output * rate.output) / 1_000_000;
};

/**
 * Estimate the token count of a piece of text.
 *
 * This is an estimate, not a tokenizer: Workers has no tokenizer and pulling in
 * a wasm one for a budget check is not worth the bundle.
 *
 * The coefficients were calibrated against a real call: a 2929-character system
 * prompt (2309 CJK + 609 other) measured 2214 input tokens, which works out to
 * ≈0.88 token/CJK char and ≈0.3 token/ASCII char. We round **up** (0.90 / 0.35)
 * because under-estimating would let the upstream truncate the system prompt,
 * while over-estimating only carries one exchange less. `npm run verify` pins
 * the calibration.
 */
export const estimateTokens = (text: string): number => {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // U+2E80 and above covers CJK ideographs and wide punctuation: one token per
    // character is the safe assumption for those.
    if ((ch.codePointAt(0) ?? 0) > 0x2e80) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.9 + other * 0.35);
};

/** UTC day (`YYYY-MM-DD`). Budgets reset at UTC midnight, like Workers AI. */
export const utcDay = (date: Date = new Date()): string => date.toISOString().slice(0, 10);
