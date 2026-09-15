import { randomUUID } from "node:crypto";
import { ResponseBuilder } from "../anthropic/response.ts";
import { streamResponse } from "../anthropic/stream.ts";
import type { MessagesRequest } from "../anthropic/type.ts";
import { PROXY_API_KEY } from "../core/config.ts";
import { log } from "../core/log.ts";
import { auth } from "../kiro/auth.ts";
import { invoke, KiroApiError } from "../kiro/client.ts";
import { systemText, textOf } from "../kiro/convert.ts";
import { KNOWN_MODELS, normalizeModel } from "../kiro/model.ts";
import { buildPayload } from "../kiro/payload.ts";
import { thinkingAsked } from "../kiro/thinking.ts";
import type { KiroPayload } from "../kiro/type.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const errorBody = (type: string, message: string): Record<string, unknown> => ({
  type: "error",
  error: { type, message },
});

/**
 * Clients send the key as either `x-api-key` (Anthropic style) or
 * `Authorization: Bearer` (OpenAI style); accept both.
 */
const authorized = (request: Request): boolean => {
  if (!PROXY_API_KEY) return true;
  const headerKey = request.headers.get("x-api-key");
  if (headerKey === PROXY_API_KEY) return true;
  const bearer = request.headers.get("authorization");
  return bearer === `Bearer ${PROXY_API_KEY}`;
};

/**
 * What one picture costs, whatever its bytes say.
 *
 * A base64 image is megabytes of characters and about 1,600 tokens, so counting
 * its characters like text would swamp everything else in the other direction.
 */
const IMAGE_TOKEN = 1600;

/**
 * An estimate of the input tokens, for the `usage` a client reads.
 *
 * ★Counts everything the model is actually sent, not just the prose. It used
 * to run `textOf` over each message, which keeps `text` and `thinking` and
 * drops `tool_use`, `tool_result` and images — in an agent conversation that
 * is nearly the whole payload. The reported figure then sat still while the
 * real one grew: 20,609 tokens for eight calls running while the payload on
 * the wire reached 7.9MB. Anything downstream that sizes a window from this
 * (ara's context gauge, its compaction scale) was reading a number that had
 * stopped moving.
 *
 * Tool schemas count too: they are sent on every call and they are not small.
 */
export const promptTokenOf = (body: MessagesRequest): number => {
  let charCount = systemText(body.system).length;
  let imageCount = 0;
  for (const message of body.messages) {
    const content = message.content;
    if (typeof content === "string") {
      charCount += content.length;
      continue;
    }
    if (!content) continue;
    for (const block of content) {
      if (block.type === "image") {
        imageCount += 1;
      } else if (block.type === "tool_use") {
        charCount += block.name.length + JSON.stringify(block.input ?? {}).length;
      } else if (block.type === "tool_result") {
        charCount +=
          typeof block.content === "string" ? block.content.length : textOf(block.content).length;
      } else {
        charCount += textOf([block]).length;
      }
    }
  }
  if (body.tools?.length) charCount += JSON.stringify(body.tools).length;
  return Math.max(1, Math.ceil(charCount / 4) + imageCount * IMAGE_TOKEN);
};

const handleMessages = async (request: Request): Promise<Response> => {
  let body: MessagesRequest;
  try {
    body = (await request.json()) as MessagesRequest;
  } catch {
    return json(errorBody("invalid_request_error", "Request body is not valid JSON"), 400);
  }

  if (!body.model) return json(errorBody("invalid_request_error", "Field 'model' is required"), 400);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json(errorBody("invalid_request_error", "Field 'messages' must be a non-empty array"), 400);
  }

  const model = normalizeModel(body.model);
  const promptToken = promptTokenOf(body);

  let payload: KiroPayload;
  try {
    payload = buildPayload(body, model, auth.profileArn, randomUUID());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(errorBody("invalid_request_error", message), 400);
  }

  log.info(`/v1/messages model=${model} stream=${body.stream === true} messages=${body.messages.length}`);

  const thinking = thinkingAsked(body);

  if (body.stream === true) {
    return streamResponse(payload, model, promptToken, request.signal, thinking);
  }

  try {
    const builder = new ResponseBuilder(thinking);
    for await (const event of invoke(payload, request.signal)) builder.accept(event);
    log.info(
      `completed model=${model} credits=${builder.credits.toFixed(4)} context=${builder.contextUsagePercent.toFixed(1)}%`,
    );
    return json(builder.response(model, promptToken));
  } catch (error) {
    if (error instanceof KiroApiError) {
      log.error(`kiro error ${error.status}: ${error.message}`);
      const type =
        error.status === 429 ? "rate_limit_error" : error.status >= 500 ? "api_error" : "invalid_request_error";
      return json(errorBody(type, error.message), error.status);
    }
    const message = error instanceof Error ? error.message : String(error);
    log.error(`unexpected error: ${message}`);
    return json(errorBody("internal_server_error", message), 500);
  }
};

const handleModels = (): Response =>
  json({
    object: "list",
    data: KNOWN_MODELS.map((id) => ({
      id,
      object: "model",
      type: "model",
      created: 0,
      owned_by: "kiro",
      display_name: id,
    })),
  });

/**
 * Some clients decide the wire protocol from the URL rather than from config:
 * a base URL ending in `/anthropic` is their signal to speak the native
 * Messages API. Accept that prefix so `<base>/anthropic` and `<base>` are the
 * same server.
 */
const stripAnthropicPrefix = (path: string): string =>
  path === "/anthropic" ? "/" : path.replace(/^\/anthropic(?=\/)/, "") || "/";

export const handle = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = stripAnthropicPrefix(url.pathname.replace(/\/+$/, "") || "/");

  if (path === "/health") {
    return json({ status: "ok", profile: auth.profileArn ?? null, host: auth.apiHost });
  }

  if (!authorized(request)) {
    return json(errorBody("authentication_error", "Invalid or missing API key"), 401);
  }

  // Accept both the bare and /v1-prefixed forms; clients disagree on which to use.
  if ((path === "/v1/messages" || path === "/messages") && request.method === "POST") {
    return handleMessages(request);
  }
  if (path === "/v1/models" || path === "/models") {
    return handleModels();
  }

  return json(errorBody("not_found_error", `Unknown route: ${request.method} ${path}`), 404);
};
