# Model providers

`xiu-xian-game` never talks to a vendor SDK. The Worker resolves one provider
from environment variables at request time; the frontend and the game logic do
not change when you swap models.

## Two providers

| Provider | Selected when | Default model | Billing unit |
| --- | --- | --- | --- |
| Cloudflare Workers AI | `LLM_PROVIDER` is unset and no `LLM_BASE_URL` is set, or `LLM_PROVIDER=cloudflare` | `@cf/qwen/qwen3-30b-a3b-fp8` | neurons |
| OpenAI-compatible | `LLM_BASE_URL` is set, or `LLM_PROVIDER=openai` | `gpt-4o-mini` | tokens |

The OpenAI-compatible path is a plain `POST {LLM_BASE_URL}/chat/completions`
with a JSON body. It works with the official OpenAI API and with any gateway
that speaks the same protocol — DeepSeek, Moonshot, DashScope, OpenRouter,
Ollama, vLLM, LiteLLM, and so on.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `LLM_PROVIDER` | no | `cloudflare` or `openai`. Inferred from the two variables below when omitted. |
| `LLM_BASE_URL` | OpenAI-compatible only | Base URL including the version segment, e.g. `https://api.deepseek.com/v1`. The Worker appends `/chat/completions`. |
| `LLM_API_KEY` | usually | Bearer token. Store it as a Worker secret, never as a `[vars]` entry or in git. Local gateways (Ollama, vLLM) may not need one. |
| `LLM_MODEL` | no | Model id. Defaults to the Workers AI model or `gpt-4o-mini`. |
| `GAME_STUB` | no | `1` answers with a fixed stub without calling a model. Budget accounting and validation still run. |

The Workers AI binding itself is declared in `wrangler.toml`:

```toml
[ai]
binding = "AI"
```

## Example: switch to DeepSeek

```toml
# wrangler.toml
[vars]
LLM_BASE_URL = "https://api.deepseek.com/v1"
LLM_MODEL = "deepseek-chat"
```

```bash
npx wrangler secret put LLM_API_KEY
npx wrangler deploy
```

`GET /api/health` then reports `provider: "openai"` and the active model. The
daily budget switches unit automatically: tokens instead of neurons.

## Rules the provider layer follows

- **Non-streaming.** The Worker waits for the full completion and emits one SSE
  event; the browser typewriter handles the reveal. This keeps one response
  shape and one failure mode.
- **Usage is never trusted to be present.** If a gateway omits `usage`, input
  and output tokens are estimated locally so the daily budget cannot be
  bypassed.
- **Errors are logged, not returned.** The player sees a short message; the
  upstream status and body slice go to `wrangler tail` only.
