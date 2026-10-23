# 大模型配置

`xiu-xian-game` 不依赖任何厂商 SDK。Worker 在每次请求时从环境变量解析出一个
Provider，前端与游戏逻辑都不需要改动即可换模型。

## 两种 Provider

| Provider | 选择条件 | 默认模型 | 计费单位 |
| --- | --- | --- | --- |
| Cloudflare Workers AI | 未设置 `LLM_PROVIDER` 且未设置 `LLM_BASE_URL`，或 `LLM_PROVIDER=cloudflare` | `@cf/qwen/qwen3-30b-a3b-fp8` | 神经元 |
| OpenAI 兼容协议 | 设置了 `LLM_BASE_URL`，或 `LLM_PROVIDER=openai` | `gpt-4o-mini` | token |

OpenAI 兼容路径就是一个普通的 `POST {LLM_BASE_URL}/chat/completions` JSON
请求，适用于 OpenAI 官方接口，也适用于任何同协议的网关：DeepSeek、Moonshot、
DashScope、OpenRouter、Ollama、vLLM、LiteLLM 等。

## 环境变量

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `LLM_PROVIDER` | 否 | `cloudflare` 或 `openai`；不填时按下面两个变量推断。 |
| `LLM_BASE_URL` | 仅 OpenAI 兼容时需要 | 含版本段的根地址，例如 `https://api.deepseek.com/v1`，Worker 会自动拼接 `/chat/completions`。 |
| `LLM_API_KEY` | 通常需要 | Bearer Token，**必须**用 Worker secret 保存，不要写进 `[vars]` 或仓库。本地网关（Ollama、vLLM）可能不需要。 |
| `LLM_MODEL` | 否 | 模型 id，默认取 Workers AI 模型或 `gpt-4o-mini`。 |
| `GAME_STUB` | 否 | 设为 `1` 时不调用模型，直接回固定桩文案；额度记账与参数校验照常执行。 |

Workers AI 的绑定在 `wrangler.toml` 中声明：

```toml
[ai]
binding = "AI"
```

## 示例：切换到 DeepSeek

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

之后 `GET /api/health` 会返回 `provider: "openai"` 与当前模型；每日额度会自动
从「神经元」切换为「token」。

## Provider 层的约定

- **非流式**：Worker 等模型出完整结果后一次性发一个 SSE 事件，逐字效果交给前端
  打字机。只有一种响应形状、一种失败模式。
- **不信任网关一定返回 usage**：缺失时在本地估算输入/输出 token，避免绕过每日额度。
- **错误只进日志**：玩家只看到一句短提示，上游状态码与响应片段只出现在
  `wrangler tail` 里。
