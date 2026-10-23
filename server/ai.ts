/**
 * Model providers — one small interface, two implementations.
 *
 * The game does not want to care which model narrates it. Two providers are
 * supported and selected by environment variables only, so swapping models does
 * not require a code change:
 *
 * | `LLM_PROVIDER` | what is called | billing unit |
 * |---|---|---|
 * | `cloudflare` (default) | the `AI` binding from `wrangler.toml` | neurons |
 * | `openai` | `POST {LLM_BASE_URL}/chat/completions` | tokens |
 *
 * The OpenAI-compatible path also covers every vendor that speaks the same
 * protocol (DeepSeek, Moonshot, Qwen/DashScope, OpenRouter, a local Ollama or
 * LiteLLM gateway, …): point `LLM_BASE_URL` at its `/v1` root and set
 * `LLM_MODEL`.
 *
 * ## No secrets in the repository
 *
 * `LLM_API_KEY` is a Worker secret (`wrangler secret put LLM_API_KEY`), never a
 * constant and never a `[vars]` entry. The Cloudflare path needs no key at all.
 */

import {
  GAME_DEFAULT_OPENAI_MODEL,
  GAME_MODEL,
  estimateTokens
} from './limits.ts';

export type ProviderKind = 'cloudflare' | 'openai';

/** A resolved provider. Only the fields its kind needs are populated. */
export interface Provider {
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Environment slice the provider resolver reads. */
export interface ProviderEnv {
  /** Workers AI binding, declared by `[ai]` in `wrangler.toml`. */
  AI?: Ai;
  /** `cloudflare` | `openai`. Optional; inferred from the other variables. */
  LLM_PROVIDER?: string;
  /** OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. */
  LLM_BASE_URL?: string;
  /** Bearer token for the OpenAI-compatible endpoint. Use a Worker secret. */
  LLM_API_KEY?: string;
  /** Model id. Defaults to the Workers AI model or `gpt-4o-mini`. */
  LLM_MODEL?: string;
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type ProviderResolution = { ok: true; provider: Provider } | { ok: false; reason: string };

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Pick the provider.
 *
 * Explicit `LLM_PROVIDER` wins; otherwise the presence of `LLM_BASE_URL` means
 * "openai", and the `AI` binding is the last resort. Resolution never throws —
 * the caller turns a failure into a 503 with a readable message, which is what
 * an operator sees after forgetting to configure anything.
 */
export const resolveProvider = (env: ProviderEnv): ProviderResolution => {
  const explicit = nonEmpty(env.LLM_PROVIDER)?.toLowerCase();
  const baseUrl = nonEmpty(env.LLM_BASE_URL);
  const apiKey = nonEmpty(env.LLM_API_KEY);
  const model = nonEmpty(env.LLM_MODEL);

  const wantOpenAi = explicit === 'openai' || (explicit === undefined && baseUrl !== undefined);

  if (wantOpenAi) {
    if (baseUrl === undefined) {
      return { ok: false, reason: 'LLM_BASE_URL is required when LLM_PROVIDER=openai' };
    }
    // A local gateway (Ollama, LiteLLM, vLLM) may not require a key; a hosted
    // vendor will reject the call and the error surfaces in the logs.
    return {
      ok: true,
      provider: {
        kind: 'openai',
        model: model ?? GAME_DEFAULT_OPENAI_MODEL,
        baseUrl,
        apiKey
      }
    };
  }

  if (env.AI === undefined) {
    return {
      ok: false,
      reason: 'no model configured: bind Workers AI ([ai]) or set LLM_BASE_URL'
    };
  }

  return { ok: true, provider: { kind: 'cloudflare', model: model ?? GAME_MODEL } };
};

/** Text extraction: Workers AI answers with `response`, OpenAI with `choices`. */
export const extractText = (payload: unknown): string => {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  const record = payload as Record<string, unknown>;
  if (typeof record.response === 'string') return record.response;

  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
    const content = first?.message?.content;
    if (typeof content === 'string') return content;
    // Some gateways return content parts instead of a plain string.
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          const text = (part as { text?: unknown })?.text;
          return typeof text === 'string' ? text : '';
        })
        .join('');
    }
    if (typeof first?.text === 'string') return first.text;
  }

  if (typeof record.result === 'string') return record.result;
  return '';
};

/** Read token usage from either protocol. Returns zeros when it is absent. */
export const readTokenUsage = (payload: unknown): { input: number; output: number } => {
  const usage = (payload as { usage?: Record<string, unknown> } | null)?.usage;
  if (usage === undefined || usage === null) return { input: 0, output: 0 };
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    input: num(usage.prompt_tokens ?? usage.input_tokens),
    output: num(usage.completion_tokens ?? usage.output_tokens)
  };
};

/** Join a base URL with an API path, tolerating a trailing slash. */
const joinUrl = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/, '')}${path}`;

/**
 * Run one non-streaming completion.
 *
 * Both paths return the full text at once; the typewriter effect is the
 * frontend's job (`Typewriter` in `public/js/game.js`). Streaming is
 * deliberately not implemented: it would add a second response shape (and a
 * second failure mode) for no player-visible difference.
 *
 * Token usage falls back to a local estimate when a provider omits it, so the
 * daily budget can never be bypassed by a silent gateway.
 */
export const chatCompletion = async (env: ProviderEnv, provider: Provider, request: ChatRequest): Promise<ChatResult> => {
  let payload: unknown;

  if (provider.kind === 'openai') {
    const response = await fetch(joinUrl(provider.baseUrl ?? '', '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey === undefined ? {} : { authorization: `Bearer ${provider.apiKey}` })
      },
      body: JSON.stringify({
        model: provider.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature
      })
    });

    const body = await response.text();
    if (!response.ok) {
      // Status + a short body slice is enough to debug a misconfigured gateway;
      // the body never contains the key.
      throw new Error(`openai-compatible http ${response.status}: ${body.slice(0, 200)}`);
    }
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error('openai-compatible endpoint returned non-JSON body');
    }
  } else {
    if (env.AI === undefined) throw new Error('Workers AI binding is missing');
    payload = await env.AI.run(provider.model as never, {
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature
    } as never);
  }

  const text = extractText(payload).trim();
  const usage = readTokenUsage(payload);
  const estimatedInput =
    request.messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);

  return {
    text,
    inputTokens: usage.input > 0 ? usage.input : estimatedInput,
    outputTokens: usage.output > 0 ? usage.output : estimateTokens(text)
  };
};
