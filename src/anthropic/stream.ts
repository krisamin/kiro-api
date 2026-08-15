import { log } from "../core/log.ts";
import { invoke, KiroApiError } from "../kiro/client.ts";
import type { KiroPayload } from "../kiro/type.ts";
import { estimateTokens, mapStopReason, messageId } from "./response.ts";

/**
 * Anthropic SSE streaming.
 *
 * The event order is part of the contract clients rely on:
 *   message_start
 *   (content_block_start -> content_block_delta* -> content_block_stop)*
 *   message_delta (stop_reason + usage)
 *   message_stop
 *
 * Kiro interleaves text and tool events freely, so an open block is closed
 * before a different block opens; indices stay monotonic.
 */

const encoder = new TextEncoder();

const sse = (event: string, data: unknown): Uint8Array =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

type OpenBlock = { kind: "text"; index: number } | { kind: "tool"; index: number; id: string } | undefined;

export const streamResponse = (
  payload: KiroPayload,
  model: string,
  promptText: string,
  signal: AbortSignal,
): Response => {
  const id = messageId();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const toolJson = new Map<string, string>();
      let open: OpenBlock;
      let nextIndex = 0;
      let outputText = "";
      let stopReason: string | undefined;
      let sawToolUse = false;

      const closeOpen = (): void => {
        if (!open) return;
        controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: open.index }));
        open = undefined;
      };

      try {
        controller.enqueue(
          sse("message_start", {
            type: "message_start",
            message: {
              id,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: estimateTokens(promptText), output_tokens: 0 },
            },
          }),
        );
        controller.enqueue(sse("ping", { type: "ping" }));

        for await (const event of invoke(payload, signal)) {
          if (signal.aborted) break;

          if (event.type === "assistantResponse") {
            const chunk = event.data.content ?? "";
            if (!chunk) continue;
            if (open?.kind !== "text") {
              closeOpen();
              open = { kind: "text", index: nextIndex++ };
              controller.enqueue(
                sse("content_block_start", {
                  type: "content_block_start",
                  index: open.index,
                  content_block: { type: "text", text: "" },
                }),
              );
            }
            outputText += chunk;
            controller.enqueue(
              sse("content_block_delta", {
                type: "content_block_delta",
                index: open.index,
                delta: { type: "text_delta", text: chunk },
              }),
            );
            continue;
          }

          if (event.type === "toolUse") {
            const { toolUseId, name, input, stop } = event.data;
            sawToolUse = true;

            if (!(open?.kind === "tool" && open.id === toolUseId)) {
              closeOpen();
              open = { kind: "tool", index: nextIndex++, id: toolUseId };
              toolJson.set(toolUseId, "");
              controller.enqueue(
                sse("content_block_start", {
                  type: "content_block_start",
                  index: open.index,
                  content_block: { type: "tool_use", id: toolUseId, name, input: {} },
                }),
              );
            }

            if (input) {
              toolJson.set(toolUseId, (toolJson.get(toolUseId) ?? "") + input);
              controller.enqueue(
                sse("content_block_delta", {
                  type: "content_block_delta",
                  index: open.index,
                  delta: { type: "input_json_delta", partial_json: input },
                }),
              );
            }
            if (stop) closeOpen();
            continue;
          }

          if (event.type === "metadata" && event.data.stopReason) {
            stopReason = event.data.stopReason;
          }
        }

        closeOpen();

        const outputTokens = estimateTokens(outputText) + toolJson.size * 8;
        controller.enqueue(
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: mapStopReason(stopReason, sawToolUse), stop_sequence: null },
            usage: { output_tokens: outputTokens },
          }),
        );
        controller.enqueue(sse("message_stop", { type: "message_stop" }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`stream failed: ${message}`);
        // The HTTP status is already 200 by this point, so the failure has to be
        // reported inside the stream where the client will actually see it.
        controller.enqueue(
          sse("error", {
            type: "error",
            error: { type: error instanceof KiroApiError ? "api_error" : "internal_server_error", message },
          }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
};
