import { randomUUID } from "node:crypto";
import { log } from "../core/log.ts";
import { auth } from "./auth.ts";
import { EventStreamDecoder } from "./event-stream.ts";
import type {
  AssistantResponseEvent,
  ContextUsageEvent,
  KiroEvent,
  KiroPayload,
  MetadataEvent,
  MeteringEvent,
  ToolUseEvent,
} from "./type.ts";

/** Mirrors the Kiro IDE client so the service accepts our requests. */
const buildHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/x-amz-json-1.0",
  "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
  "user-agent":
    "aws-sdk-js/1.0.27 ua/2.1 os/win32#10.0.19044 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-kiro-api",
  "x-amz-user-agent": "aws-sdk-js/1.0.27 KiroIDE-0.7.45-kiro-api",
  "x-amzn-codewhisperer-optout": "true",
  "x-amzn-kiro-agent-mode": "vibe",
  "amz-sdk-invocation-id": randomUUID(),
  "amz-sdk-request": "attempt=1; max=3",
});

const parseJson = (bytes: Uint8Array): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const toEvent = (eventType: string, raw: Record<string, unknown>): KiroEvent => {
  switch (eventType) {
    case "assistantResponseEvent":
      return { type: "assistantResponse", data: raw as AssistantResponseEvent };
    case "toolUseEvent":
      return { type: "toolUse", data: raw as unknown as ToolUseEvent };
    case "metadataEvent":
      return { type: "metadata", data: raw as MetadataEvent };
    case "contextUsageEvent":
      return { type: "contextUsage", data: raw as ContextUsageEvent };
    case "meteringEvent":
      return { type: "metering", data: raw as MeteringEvent };
    default:
      return { type: "unknown", name: eventType, data: raw };
  }
};

export class KiroApiError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "KiroApiError";
  }
}

/**
 * Call `generateAssistantResponse` and yield decoded events as they arrive.
 *
 * Retries once on 401/403 because an access token can expire between the
 * freshness check and the request actually landing.
 */
export async function* invoke(payload: KiroPayload, signal?: AbortSignal): AsyncGenerator<KiroEvent> {
  let response = await send(payload, signal);

  if (response.status === 401 || response.status === 403) {
    log.warn(`auth rejected (${response.status}); forcing token refresh and retrying once`);
    await response.body?.cancel();
    response = await send(payload, signal, true);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new KiroApiError(extractMessage(body, response.status), response.status, body);
  }
  if (!response.body) throw new KiroApiError("Kiro returned an empty body", 502, "");

  const decoder = new EventStreamDecoder();
  const reader = response.body.getReader();
  let drained = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (!value) continue;

      for (const frame of decoder.push(value)) {
        const eventType = frame.headers[":event-type"] ?? "";
        const messageType = frame.headers[":message-type"] ?? "";

        // AWS signals modelled errors through the frame headers, not the status.
        if (messageType === "exception" || eventType.endsWith("Exception")) {
          const raw = parseJson(frame.payload);
          const message = typeof raw.message === "string" ? raw.message : `Kiro exception: ${eventType}`;
          throw new KiroApiError(message, 400, new TextDecoder().decode(frame.payload));
        }

        yield toEvent(eventType, parseJson(frame.payload));
      }
    }
    if (decoder.pending > 0) log.warn(`stream ended with ${decoder.pending} trailing bytes`);
  } finally {
    reader.releaseLock();
    // releaseLock alone leaves the body live — it keeps streaming from the
    // socket. Any early exit (a thrown frame, a client disconnect running the
    // generator's return()) must cancel it or the connection leaks.
    if (!drained) await response.body.cancel().catch(() => {});
  }
}

const send = async (payload: KiroPayload, signal?: AbortSignal, forceRefresh = false): Promise<Response> => {
  const token = forceRefresh ? await auth.forceRefresh() : await auth.token();
  return fetch(`${auth.apiHost}/generateAssistantResponse`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(payload),
    signal: signal ?? null,
  });
};

/** Kiro reports most problems as a JSON body with a `message` field. */
const extractMessage = (body: string, status: number): string => {
  try {
    const parsed = JSON.parse(body) as { message?: string; reason?: string };
    return parsed.message ?? parsed.reason ?? `Kiro request failed with status ${status}`;
  } catch {
    return body.slice(0, 300) || `Kiro request failed with status ${status}`;
  }
};
