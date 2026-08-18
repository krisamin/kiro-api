# kiro-api

An Anthropic-compatible API server in front of Kiro (Amazon Q Developer).

Any client that speaks the Anthropic Messages API can talk to Kiro through it. It reads the credentials `kiro-cli login` already wrote, converts Anthropic requests into Kiro's `generateAssistantResponse` format, and converts the streamed response back. Text, tool calls, images, and streaming are supported.

```
Anthropic client  ──POST /v1/messages──▶  kiro-api  ──▶  runtime.us-east-1.kiro.dev
                  ◀────── SSE ─────────            ◀───   (AWS event stream)
```

## Requirements

* [Bun](https://bun.sh) 1.2 or newer
* [`kiro-cli`](https://kiro.dev), logged in
* A Kiro subscription. This is a protocol adapter, not a way around one. It spends your own quota through your own credentials.

## Getting started

Log in first. `kiro-cli` stores the tokens and this server only reads them.

```bash
kiro-cli login --license pro \
  --identity-provider https://your-sso.awsapps.com/start \
  --region ap-northeast-2 --use-device-flow
```

Then start the server:

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

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/messages` | Anthropic Messages API, streaming and non-streaming |
| `GET` | `/v1/models` | Available model list |
| `GET` | `/health` | Credential status and upstream host |

The `/v1` prefix is optional, so `/messages` and `/models` work too.

### Tests

```bash
bun run selftest
```

This covers the conversion logic and does one live round trip. Set `KIRO_SELFTEST_LIVE=0` to skip the network part.

## Configuration

All settings are environment variables. Only the API key really needs attention, and everything else has a working default.

### Server

| Variable | Default | Description |
| --- | --- | --- |
| `KIRO_API_KEY` | none | Token clients must send as `x-api-key` or `Authorization: Bearer`. When unset the server accepts unauthenticated requests. |
| `KIRO_API_HOST` | `127.0.0.1` | Bind address. |
| `KIRO_API_PORT` | `9101` | Bind port. |
| `KIRO_LOG_LEVEL` | `info` | One of `debug`, `warn`, `error`. |

### Upstream

| Variable | Default | Description |
| --- | --- | --- |
| `KIRO_API_REGION` | `us-east-1` | Inference region, independent of the SSO region used at login. |
| `KIRO_CLI_DB` | `~/.local/share/kiro-cli/data.sqlite3` | Path to the kiro-cli credential store. |
| `TOKEN_REFRESH_SKEW_SEC` | `120` | How many seconds before expiry to refresh the access token. |

### Limits

| Variable | Default | Description |
| --- | --- | --- |
| `KIRO_MAX_PAYLOAD_BYTES` | `600000` | Ceiling for the assembled payload. Older turns are dropped until the request fits. |
| `KIRO_MAX_TOOL_DESCRIPTION` | `10000` | Tool descriptions longer than this are moved into the system prompt. |

### Running as a service

```ini
# ~/.config/systemd/user/kiro-api.service
[Unit]
Description=kiro-api
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/src/kiro-api
EnvironmentFile=%h/.config/kiro-api/env
ExecStart=%h/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=5
StandardOutput=append:%h/.local/state/kiro-api.log
StandardError=append:%h/.local/state/kiro-api.log

[Install]
WantedBy=default.target
```

`EnvironmentFile` is a plain `KEY=value` file. Keep `KIRO_API_KEY` there rather than in the unit, which is world-readable.

```bash
systemctl --user enable --now kiro-api
```

## Security

This server holds a key to a Kiro account, so anyone who can reach it can spend that quota.

**Bind to loopback.** The default is `127.0.0.1`. If you change `KIRO_API_HOST`, set `KIRO_API_KEY` as well. Without a key the server accepts unauthenticated requests and only logs a warning at startup.

**Tokens stay in kiro-cli's SQLite file.** This server reads that file and writes refreshed tokens back to it, since refresh tokens rotate on use and have to be persisted. Nothing is copied anywhere else.

**Request bodies are never logged.** Logs carry the model name, timings, chunk counts, credit spend, and errors.

## Models

Kiro's runtime endpoint has no model listing API, so `/v1/models` returns a list built by calling each model and keeping the ones that answered.

| Family | Models |
| --- | --- |
| Opus | `claude-opus-5`, `claude-opus-4.8`, `claude-opus-4.7`, `claude-opus-4.6`, `claude-opus-4.5` |
| Sonnet | `claude-sonnet-5`, `claude-sonnet-4.6`, `claude-sonnet-4.5`, `claude-sonnet-4` |
| Haiku | `claude-haiku-4.5` |
| Other | `deepseek-3.2`, `glm-5`, `minimax-m2.5`, `minimax-m2.1`, `qwen3-coder-next` |
| Alias | `auto` |

Unknown model ids are forwarded as-is instead of being rejected locally, so a newly added model works before this list catches up. Anthropic-style ids are normalised on the way in, turning `claude-opus-5-20260101` into `claude-opus-5` and `claude-opus-4-5` into `claude-opus-4.5`.

The list above reflects a Kiro Pro (Identity Center) account. Availability depends on subscription tier, so a model listed here can still return a 400 elsewhere.

## Behaviour worth knowing

**Kiro answers almost every malformed request with the same 400.** "Improperly formed request" covers an empty `required: []` in a tool schema, an `additionalProperties` key anywhere in it, an empty `toolUses` array, a history that does not start with a user turn, two same-role turns in a row, a `tool_result` whose `tool_use` is not in the message right before it, an empty content string, and a payload over roughly 615 KB. `src/kiro/convert.ts` and `src/kiro/payload.ts` exist largely to make those states unreachable, and the selftest asserts each one.

**Usage numbers are estimates.** Kiro bills in opaque credits and never reports token counts, so `usage` is a rough 4-characters-per-token approximation. Actual credit spend is written to the log for each request.

**Prompt caching happens upstream and does not appear in `usage`.** Kiro caches prompt prefixes on its own, and repeating an identical long system prompt measurably lowers the credit charge. `cache_control` markers sent by a client are accepted but dropped during conversion, and no `cache_creation_input_tokens` or `cache_read_input_tokens` fields come back. Cache effects are visible in the logged credit value only.

**No extended thinking.** Kiro's API has no thinking parameter, and none is synthesised from `<thinking>` tags.

**Everything is streamed internally.** Kiro only streams, so a non-streaming request is a streaming request that gets buffered. There is no latency benefit to `stream: false`.

**Kiro's stream is coarse-grained.** Deltas arrive in sentence or block sized chunks rather than per token, and a short answer can finish in a handful of events. They are forwarded as received, without artificial re-chunking.

**One conversation per request.** `conversationId` is generated fresh each time and history is replayed from the request, which is what an Anthropic client expects. Kiro's server-side conversation state goes unused.

**A single oversized turn cannot be trimmed.** Trimming drops whole turns from the oldest end and stops at two entries. If one turn exceeds `KIRO_MAX_PAYLOAD_BYTES` by itself there is nothing left to drop, and Kiro returns the 400.

**Device registration expires.** Run `kiro-cli login` again when that happens. Token refresh handles everything up to that point on its own.

## Project layout

| Directory | Contents |
| --- | --- |
| `src/core/` | Configuration and logging |
| `src/kiro/` | Auth, event stream decoding, converters, payload assembly, HTTP client, model registry |
| `src/anthropic/` | Response building, SSE streaming, types |
| `src/server/` | Routing |

The event stream decoder in `src/kiro/event-stream.ts` parses the AWS binary framing, including length prefixes, header blocks, and CRC32 over both the prelude and the message. It buffers partial frames, so a chunk boundary landing mid-frame or a payload containing braces cannot desync the stream.

## License

MIT. Not affiliated with, endorsed by, or supported by Amazon or Anthropic.
