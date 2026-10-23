<div align="center">

<img src="docs/assets/logo.svg" width="104" alt="凡人修仙传之我是厉飞雨" />

# 凡人修仙传之我是厉飞雨

**一个部署在单个 Cloudflare Worker 上的文字修仙游戏 —— Workers AI 负责叙事，浏览器持有剧情，一份全站每日额度守住账单。**

<a href="https://xiuxian.wordtk.com"><img alt="在线体验" src="https://img.shields.io/badge/%E2%96%B6_%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-xiuxian.wordtk.com-c9a052?style=for-the-badge"></a>

<br/>

<img alt="license" src="https://img.shields.io/badge/license-AGPL--3.0--only-8a6224?style=flat-square">
<img alt="runtime" src="https://img.shields.io/badge/runtime-Cloudflare_Workers-f38020?style=flat-square">
<img alt="ai" src="https://img.shields.io/badge/AI-Workers_AI_%7C_OpenAI_%E5%85%BC%E5%AE%B9-2f7d52?style=flat-square">
<img alt="storage" src="https://img.shields.io/badge/storage-KV_%C2%B7_%E6%97%A0%E6%95%B0%E6%8D%AE%E5%BA%93-4d7a35?style=flat-square">

<br/><br/>

[🇺🇸 English](README.md) &nbsp;·&nbsp; 🇨🇳 **简体中文**

<br/>

<img src="docs/assets/screenshot-opening.webp" width="300" alt="开场画面" />

</div>

> 你睁开眼，成为七玄门外刃堂弟子**厉飞雨** —— 此时韩立还未入七玄门。每一幕都由大模型依据
> 2,929 字的人设提示词原文 + 一段运行时硬约束生成：年龄、寿元、境界由模型推演，而不是由脚本硬算。你只需选择
> **A / B / C**，剧情便继续向前 —— 从七玄门到人界，直到渡劫。

没有账号、没有数据库、没有任何按人限流。服务端唯一记住的东西，是每天的一个数字：
全站体验额度用掉了多少。

---

## 目录

| | |
| --- | --- |
| [它是什么](#它是什么) | [游戏画面](#游戏画面) |
| [架构](#架构) | [本地开发](#本地开发) |
| [大模型配置](#大模型配置) | [每日额度](#每日额度) |
| [接口](#接口) | [部署](#部署) |
| [项目结构](#项目结构) | [许可证](#许可证) |

---

## 它是什么

- **一个页面、一个 Worker** —— H5 界面（开场视频、花瓣、打字机、音乐、设置）全部走静态资源，
  只有 `/api/*` 会进入 Worker，不消耗调用额度。
- **无状态后端** —— 最近 **15 轮**对话保存在浏览器里，每次请求随包带上。刷新页面就是新的一局；
  Worker 不存你的剧情。
- **境界由服务端结算** —— Worker 解析上一轮状态，按严格十层制（前期 1–3 / 中期 4–6 /
  后期 7–9 / 大圆满 10）每轮推进 2 层，并校正状态行；模型只负责叙事，不能卡级、跳阶或写出 11 层。
- **可换模型** —— 默认走 Workers AI（零密钥），也可以指向任何 OpenAI 兼容接口
  （`LLM_BASE_URL` + `LLM_MODEL` + 一个 secret）。前端与玩法不变，只换叙事者。
- **只有一个闸** —— KV 里的全站每日额度，没有按 IP、没有按分钟、没有按会话的计数。
  UTC 零点重置。
- **不变量有断言** —— `npm run verify` 钉住人设提示词长度、SSE 协议、额度算术、素材完整性
  以及「仓库里没有个人标识」这几条。

## 游戏画面

<div align="center">

| 游戏内：状态、事件、三个选择 | 设置：音乐、音量、源码入口 |
| --- | --- |
| <img src="docs/assets/screenshot-story.webp" width="290" alt="剧情画面" /> | <img src="docs/assets/screenshot-settings.webp" width="290" alt="设置画面" /> |

</div>

正文格式同时就是协议：前端按 `📌` 切分，把 `A.` / `B.` / `C.` 开头的行渲染成按钮。
`🔥 当前状态` 一行携带年龄、剩余寿元与境界，因此模型仅靠回放的历史就能恢复完整局面。

## 架构

```text
浏览器  （public/ —— 静态资源，由 Cloudflare 缓存，零 Worker 调用）
  ├─ 内存里保存最近 15 轮对话
  └─ POST /api/chat  { sessionId, choice, history }
                │
Worker  （server/ —— 只有 /api/* 会唤起它）
  ├─ 校验选择、清洗并二次裁剪历史（最多 30 条消息）
  ├─ 每日额度判定            KV  xiuxian:quota:neurons:YYYY-MM-DD
  ├─ Provider               env.AI.run(...)  |  POST {LLM_BASE_URL}/chat/completions
  └─ SSE                    data: {"text":"…","done":true}
                │
前端 ─ 打字机逐字显示 ─ 渲染 A/B/C 按钮
```

只用到两个 Cloudflare 产品，没有数据库：

| 绑定 | 用途 |
| --- | --- |
| `QUOTA`（KV） | 每天、每种单位一个 JSON 文档；唯一需要持久化的状态 |
| `AI`（Workers AI） | 可选 —— 配置了 OpenAI 兼容接口后就不再使用 |

为什么不做真流式：上游一次性返回完整结果，逐字效果由前端打字机完成。这样只有一种响应形状、
一种失败模式，而玩家感知到的首字延迟与真流式一致。

## 本地开发

```bash
npm install

# 1. 复用共用的 `common` KV 命名空间（每账号一个）；本项目的键一律以 `xiuxian:` 开头
#    把 id 填进 wrangler.toml
npx wrangler kv namespace create common

# 2. 起本地 dev（GAME_STUB=1 不调模型，但校验与额度照走）
npx wrangler dev --var GAME_STUB:1
# 打开 http://localhost:8787
```

想在本地调用真实模型，用 `npx wrangler dev --remote`：miniflare 的本地代理到不了 AI 绑定，
`--remote` 会把 Worker 放到 Cloudflare 边缘执行、使用真实绑定（会写线上 KV）。

`npm run check` 跑 `tsc`，`npm run verify` 跑不变量断言。

## 大模型配置

| Provider | 选择条件 | 默认模型 | 计费单位 |
| --- | --- | --- | --- |
| Cloudflare Workers AI | 有 `AI` 绑定（默认） | `@cf/qwen/qwen3-30b-a3b-fp8` | 神经元 |
| OpenAI 兼容 | 设置了 `LLM_BASE_URL` | `gpt-4o-mini` | token |

完整变量表与示例见 [`docs/zh-CN/configuration.md`](docs/zh-CN/configuration.md)：

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `LLM_PROVIDER` | 否 | `cloudflare` 或 `openai`，不填时自动推断 |
| `LLM_BASE_URL` | 仅 OpenAI 兼容 | 例如 `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | 通常需要 | Worker **secret**，绝不入库 |
| `LLM_MODEL` | 否 | 模型 id |
| `GAME_STUB` | 否 | `1` = 不调模型 |

以切换到 DeepSeek 为例：

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

`GET /api/health` 会返回当前 Provider、模型与剩余额度，切换后不花一回合就能确认。

## 每日额度

项目里唯一的成本控制，**全站共用**，不是按访客：

| Provider | 每日额度 | 为什么是这个数 |
| --- | --- | --- |
| Workers AI | **4,000 神经元** | 15 轮回放窗口下，100 轮一局约 3,657 神经元；免费账号 10,000/天，留出约 16 回合余量 |
| OpenAI 兼容 | **600,000 token** | 100 轮一局约 501k token，剩余留给更长的回复 |

额度用尽后接口回 HTTP 503 与一句可读的原因；账本 7 天后自行过期。单位跟随 Provider，
中途换模型不会污染计数。

> ⚠️ **KV 是最终一致的。** 没有原子自增，并发请求可能少量超额。这是「不为一局小游戏引入
> D1 或 Durable Object」的有意代价。需要硬上限，就把 `server/quota.ts` 换成 Durable Object。

为什么是 15 轮：每回合都要重读回放窗口，窗口就是成本旋钮。15 轮时稳态每回合约 36 神经元，
而 100 轮的完整剧情仍能在一天额度内玩完。

## 接口

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| `POST` | `/api/chat` | `{ sessionId?, choice, history? }` | SSE `data: {"text":"…","done":true}` |
| `GET` | `/api/health` | — | Provider、模型与额度快照 |

错误统一一个信封：

```json
{ "ok": false, "error": { "code": "game-budget-exhausted", "message": "今日体验额度已用完，明天再来吧。" } }
```

`choice` 开局是 `是`，之后只接受裸 `A` / `B` / `C`。`history` 视为不可信输入：非法条目丢弃、
单条超过 4,000 字符截断、数组只保留最新 30 条。

## 部署

```bash
npx wrangler kv namespace create common   # 每账号一次；把 id 填进 wrangler.toml
npx wrangler deploy
```

`wrangler.toml` 已把 Worker 绑定到自定义域名 `xiuxian.wordtk.com`，并关闭了 `workers.dev`。
换域名只需改 `[[routes]]` 的 `pattern`（域名须在同一 Cloudflare 账号下）后重新部署；
Worker 代码里没有写死任何 host —— 同源校验是拿请求自身的 host 比的。

## 项目结构

```text
public/               静态 H5 游戏（HTML、CSS、JS、音频、视频、字体）
  js/game.js          回放窗口、SSE 解析、打字机、花瓣
  assets/             开场视频、背景图、BGM、完整 CJK 字体
server/
  index.ts            Worker 入口：/api/chat、/api/health、同源校验
  game.ts             校验 → 额度 → 回放窗口 → 模型 → 记账
  ai.ts               Provider 解析与两条调用路径
  quota.ts            KV 每日账本（软上限，已在注释里说明）
  limits.ts           额度、神经元单价、token 估算
  prompt.ts           2,929 字人设提示词原文
scripts/verify.mts    不变量断言（提示词、SSE、额度、素材、仓库卫生）
docs/                 logo、截图、en/ 与 zh-CN/ 配置说明
```

## 许可证

**AGPL-3.0-only** —— 见 [`LICENSE`](LICENSE)。如果你把修改版作为网络服务对外提供，
该版本必须同样以本协议提供源码；游戏设置页里的「源码 / Source」入口就是为此准备的。

另有**商业授权**（闭源使用、私有部署、转售）可选：在本仓库提 issue，或通过
[@onblog](https://github.com/onblog) 联系作者。商业授权仅覆盖本仓库代码；
《凡人修仙传》的世界观与人物权利仍归版权方所有。

Copyright © 2026 Martin。

## 声明

非商业同人项目。《凡人修仙传》为忘语所著小说；本项目与作者及版权方无关联，也未获其背书。
