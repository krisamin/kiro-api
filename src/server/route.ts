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

/** Text used only to estimate input tokens for the usage field. */
const promptTextOf = (body: MessagesRequest): string => {
  const parts = [systemText(body.system)];
  for (const message of body.messages) parts.push(textOf(message.content));
  return parts.filter(Boolean).join("\n");
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
  const promptText = promptTextOf(body);

  let payload: KiroPayload;
  try {
    payload = buildPayload(body, model, auth.profileArn, randomUUID());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(errorBody("invalid_request_error", message), 400);
  }

  log.info(`/v1/messages model=${model} stream=${body.stream === true} messages=${body.messages.length}`);

  if (body.stream === true) {
    return streamResponse(payload, model, promptText, request.signal);
  }

  try {
    const builder = new ResponseBuilder();
    for await (const event of invoke(payload, request.signal)) builder.accept(event);
    log.info(
      `completed model=${model} credits=${builder.credits.toFixed(4)} context=${builder.contextUsagePercent.toFixed(1)}%`,
    );
    return json(builder.response(model, promptText));
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

export const handle = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

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
