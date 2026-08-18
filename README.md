# kiro-api

An Anthropic-compatible API server in front of Kiro (Amazon Q Developer).

It lets any client that speaks the Anthropic Messages API talk to Kiro. It reads the credentials `kiro-cli login` already wrote, translates Anthropic requests into Kiro's `generateAssistantResponse` format, and translates the streamed response back. Text, tool calls, images, and streaming are supported.

```
Anthropic client  ──POST /v1/messages──▶  kiro-api  ──▶  runtime.us-east-1.kiro.dev
                  ◀────── SSE ─────────            ◀───   (AWS event stream)
```

## Requirements

- [Bun](https://bun.sh) 1.2 or newer
- [`kiro-cli`](https://kiro.dev), logged in
- A Kiro subscription. This is a protocol adapter, not a way around one — it spends your own quota through your own credentials.

## Run it

Log in first. `kiro-cli` stores the tokens; this server only reads them.

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

Three endpoints: `POST /v1/messages`, `GET /v1/models`, `GET /health`. The `/v1` prefix is optional.

`bun run selftest` exercises the conversion logic and does one live round trip. Set `KIRO_SELFTEST_LIVE=0` to skip the network part.

### As a service

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

`EnvironmentFile` is a plain `KEY=value` file. Put `KIRO_API_KEY` there rather than in the unit, which is world-readable.

```bash
systemctl --user enable --now kiro-api
```

## Configuration

Everything is an environment variable, all optional except the key:

**KIRO_API_KEY:** bearer token clients must send, as `x-api-key` or `Authorization: Bearer`. Unset means no auth, which is only reasonable on loopback.
**KIRO_API_HOST / KIRO_API_PORT:** defaults `127.0.0.1` and `9101`.
**KIRO_API_REGION:** inference region, default `us-east-1`. Separate from the SSO region.
**KIRO_CLI_DB:** path to the kiro-cli SQLite store, default `~/.local/share/kiro-cli/data.sqlite3`.
**KIRO_MAX_PAYLOAD_BYTES:** history trim ceiling, default 600000.
**KIRO_MAX_TOOL_DESCRIPTION:** tool descriptions longer than this move into the system prompt, default 10000.
**TOKEN_REFRESH_SKEW_SEC:** refresh this many seconds before expiry, default 120.
**KIRO_LOG_LEVEL:** `debug`, `info`, `warn`, `error`.

## Security

This server holds a key to a Kiro account. Anyone who can reach it can spend that quota.

- **Bind to loopback.** The default is `127.0.0.1`. If you change `KIRO_API_HOST`, set `KIRO_API_KEY` as well — without a key the server accepts unauthenticated requests and only logs a warning at startup.
- **Tokens stay in kiro-cli's SQLite file.** This server reads that file and writes refreshed tokens back to it, since refresh tokens rotate on use and have to be persisted. Nothing is copied elsewhere.
- **Request bodies are not logged.** Logs carry model, timing, chunk counts, credit spend, and errors.

## Models

Kiro's runtime endpoint has no model-listing API, so `/v1/models` returns a list built by calling each model and keeping the ones that answered. On a Kiro Pro (Identity Center) account:

`auto`, `claude-opus-5`, `claude-opus-4.8`, `claude-opus-4.7`, `claude-opus-4.6`, `claude-opus-4.5`, `claude-sonnet-5`, `claude-sonnet-4.6`, `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `deepseek-3.2`, `glm-5`, `minimax-m2.5`, `minimax-m2.1`, `qwen3-coder-next`

Unknown model ids are forwarded as-is rather than rejected locally, so a newly added model works before this list catches up. Anthropic-style ids are normalised on the way in — `claude-opus-5-20260101` and `claude-opus-4-5` become `claude-opus-5` and `claude-opus-4.5`.

Availability depends on subscription tier, so a model listed here can still return a 400 on a different account.

## Caveats

**Kiro answers almost every malformed request with the same 400.** "Improperly formed request" covers an empty `required: []` in a tool schema, an `additionalProperties` key anywhere in it, an empty `toolUses` array, a history that doesn't start with a user turn, two same-role turns in a row, a `tool_result` whose `tool_use` isn't in the message right before it, an empty content string, and a payload over ~615KB. `src/kiro/convert.ts` and `src/kiro/payload.ts` exist largely to make those states unreachable, and the selftest asserts each one.

**Usage numbers are estimates.** Kiro bills in opaque credits and does not report tokens, so `usage` is a ~4-chars-per-token approximation. Actual credit spend is logged per request instead.

**Prompt caching happens server-side and is not visible in `usage`.** Kiro caches prompt prefixes on its own; repeating an identical long system prompt measurably lowers the credit charge. `cache_control` markers sent by a client are accepted but dropped during conversion, and no `cache_creation_input_tokens` / `cache_read_input_tokens` fields are returned. Cache effects show up in the logged credit value, not in the response body.

**No extended thinking.** Kiro's API has no thinking parameter, and none is synthesised from `<thinking>` tags.

**Responses are streamed internally either way.** Kiro only streams, so a non-streaming request is a streaming request that gets buffered. There is no latency advantage to `stream: false`.

**Kiro's stream is coarse-grained.** Deltas arrive in sentence- or block-sized chunks rather than per token, and short answers can complete in a handful of events. They are forwarded as received, without artificial re-chunking.

**One conversation per request.** `conversationId` is generated fresh each time and history is replayed from the request, matching what an Anthropic client expects. Kiro's server-side conversation state is unused.

**A single turn larger than the ceiling cannot be trimmed.** History trimming drops whole turns from the oldest end and stops at two entries. If one turn exceeds `KIRO_MAX_PAYLOAD_BYTES` by itself, there is nothing left to drop and Kiro returns the 400.

**Device registration expires.** Run `kiro-cli login` again when it does; token refresh handles everything up to that point automatically.

## Layout

```
src/
├── core/        config, logging
├── kiro/        auth (SQLite + token refresh), event-stream decoder,
│                converters, payload assembly, HTTP client, model registry
├── anthropic/   response building, SSE streaming, types
└── server/      routing
```

The event-stream decoder in `src/kiro/event-stream.ts` parses the AWS binary framing — length prefixes, header blocks, CRC32 on both the prelude and the message — and buffers partial frames, so a chunk boundary landing mid-frame or a payload containing braces cannot desync the stream.

## License

MIT. Not affiliated with, endorsed by, or supported by Amazon or Anthropic.
