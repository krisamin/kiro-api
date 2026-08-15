# kiro-api

An Anthropic-compatible API server in front of Kiro (Amazon Q Developer). I wrote it because I wanted to use my Kiro subscription from tools that only speak the Anthropic Messages API — Hermes, in my case — and the existing proxy I tried was AGPL and did a few things I didn't want to inherit.

It reads the credentials `kiro-cli login` already wrote, translates Anthropic requests into Kiro's `generateAssistantResponse` format, and translates the streamed response back. Text, tool calls, images, and streaming all work.

## Run it

You need to be logged in first:

```bash
kiro-cli login --license pro \
  --identity-provider https://your-sso.awsapps.com/start \
  --region ap-northeast-2 --use-device-flow
```

Then:

```bash
bun install
KIRO_API_KEY=$(openssl rand -hex 16) bun run start
```

It listens on `127.0.0.1:9101`. Point any Anthropic client at it:

```bash
curl -s http://127.0.0.1:9101/v1/messages \
  -H "x-api-key: $KIRO_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-5","max_tokens":100,
       "messages":[{"role":"user","content":"hi"}]}'
```

`bun run selftest` exercises the conversion logic and does one live round trip.

## Configuration

Everything is an environment variable, all optional except the key:

**KIRO_API_KEY:** bearer token clients must send, as `x-api-key` or `Authorization: Bearer`. Unset means no auth, which is only reasonable on loopback.
**KIRO_API_HOST / KIRO_API_PORT:** defaults `127.0.0.1` and `9101`.
**KIRO_API_REGION:** inference region, default `us-east-1`. This is separate from your SSO region.
**KIRO_CLI_DB:** path to the kiro-cli SQLite store, default `~/.local/share/kiro-cli/data.sqlite3`.
**KIRO_MAX_PAYLOAD_BYTES:** history trim ceiling, default 600000.
**KIRO_LOG_LEVEL:** `debug`, `info`, `warn`, `error`.

## Models

Kiro's runtime endpoint has no model-listing API, so `/v1/models` returns a list that was built by actually calling each model and keeping the ones that answered. On a Kiro Pro (Identity Center) account that's:

`auto`, `claude-opus-5`, `claude-opus-4.8`, `claude-opus-4.7`, `claude-opus-4.6`, `claude-opus-4.5`, `claude-sonnet-5`, `claude-sonnet-4.6`, `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `deepseek-3.2`, `glm-5`, `minimax-m2.5`, `minimax-m2.1`, `qwen3-coder-next`

Unknown model ids are forwarded as-is rather than rejected locally, so a model Kiro adds tomorrow works before this list catches up. Anthropic-style ids get normalised on the way in — `claude-opus-5-20260101` and `claude-opus-4-5` become `claude-opus-5` and `claude-opus-4.5`.

Availability depends on your subscription tier, so a model listed here can still come back as a 400 on a different account.

## Caveats

**Kiro answers almost every malformed request with the same 400.** "Improperly formed request" covers an empty `required: []` in a tool schema, an `additionalProperties` key anywhere in it, an empty `toolUses` array, a history that doesn't start with a user turn, two same-role turns in a row, a `tool_result` whose `tool_use` isn't in the message right before it, an empty content string, and a payload over ~615KB. `src/kiro/convert.ts` and `src/kiro/payload.ts` exist almost entirely to make those states unreachable. The selftest asserts each one.

**Usage numbers are estimates.** Kiro bills in opaque credits and never reports tokens, so `usage` is a ~4-chars-per-token approximation. The real credit spend is logged per request instead. If you need exact accounting, this is not the place to get it.

**No extended thinking.** Kiro's API has no thinking parameter. Some proxies fake it by asking the model to emit `<thinking>` tags and re-wrapping those as thinking blocks; this doesn't, because a reconstructed block claiming to be extended thinking isn't one.

**Responses are streamed internally either way.** Kiro only streams, so a non-streaming request is a streaming request that gets buffered. There's no latency advantage to `stream: false`.

**One conversation per request.** `conversationId` is generated fresh each time and history is replayed from the request, which is what an Anthropic client expects. Kiro's server-side conversation state is unused.

## Layout

```
src/
├── core/        config, logging
├── kiro/        auth (SQLite + token refresh), event-stream decoder,
│                converters, payload assembly, HTTP client, model registry
├── anthropic/   response building, SSE streaming, types
└── server/      routing
```

The event-stream decoder in `src/kiro/event-stream.ts` parses the real AWS binary framing — length prefixes, header blocks, CRC32 on both the prelude and the message — and buffers partial frames, so a chunk boundary landing mid-frame or a payload containing braces can't desync the stream.
