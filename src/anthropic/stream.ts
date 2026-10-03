import { PING_INTERVAL_MS } from "../core/config.ts";
import { log } from "../core/log.ts";
import { planOf } from "../kiro/cache.ts";
import { KiroApiError } from "../kiro/client.ts";
import { invokeFitted, overflowed, overflowMessage } from "../kiro/fit.ts";
import { dumpEmpty, refusalOf } from "../kiro/refusal.ts";
import { type ThinkingPiece, ThinkingSplitter } from "../kiro/thinking.ts";
import type { KiroPayload } from "../kiro/type.ts";
import { estimateTokens, mapStopReason, messageId, promptFromContext, usageOf } from "./response.ts";

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
 *
 * With thinking on, one more thing splits: the model writes its reasoning
 * between tags inside the same text stream, and it becomes thinking blocks here
 * (kiro/thinking.ts). Nothing about the ordering changes - a thinking block is
 * just another block, opened and closed like the rest.
 */

const encoder = new TextEncoder();

const sse = (event: string, data: unknown): Uint8Array =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

type OpenBlock =
  | { kind: "text"; index: number }
  | { kind: "thinking"; index: number }
  | { kind: "tool"; index: number; id: string }
  | undefined;

export const streamResponse = (
  payload: KiroPayload,
  model: string,
  promptToken: number,
  signal: AbortSignal,
  splitThinking = false,
): Response => {
  const id = messageId();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Only the tool *count* feeds the usage estimate; the streamed JSON is
      // already forwarded to the client as input_json_delta and never re-read
      // here, so accumulating it would just hold large strings for nothing.
      const toolIds = new Set<string>();
      const splitter = splitThinking ? new ThinkingSplitter() : null;
      let open: OpenBlock;
      let nextIndex = 0;
      let outputText = "";
      let stopReason: string | undefined;
      let sawToolUse = false;
      const startedAt = performance.now();
      let firstTextAt = 0;
      let chunkCount = 0;
      let thoughtChars = 0;
      let contextPercent = 0;
      let credits = 0;
      let refusal: string | undefined;

      const closeOpen = (): void => {
        if (!open) return;
        controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: open.index }));
        open = undefined;
      };

      /*
       * Keep the connection audibly alive while Kiro thinks.
       *
       * Silence and death look identical to anything watching the socket, and
       * Kiro is legitimately silent for tens of seconds before a tool call on a
       * long conversation. ara's device relay ends a request after 30s without
       * an event, which is how this turned into "device response timed out"
       * mid-answer. The interval is cleared before the stream closes, so a ping
       * can never be queued onto a closed controller.
       */
      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive) return;
        controller.enqueue(sse("ping", { type: "ping" }));
      }, PING_INTERVAL_MS);

      const startBlock = (kind: "text" | "thinking"): { kind: "text" | "thinking"; index: number } => {
        closeOpen();
        const block = { kind, index: nextIndex++ };
        open = block;
        controller.enqueue(
          sse("content_block_start", {
            type: "content_block_start",
            index: block.index,
            content_block: kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
          }),
        );
        return block;
      };

      /** Write reasoning and answer pieces out as their own blocks. */
      const writePieces = (pieceList: ThinkingPiece[]): void => {
        for (const piece of pieceList) {
          const current = open;
          const block = current && current.kind === piece.kind ? current : startBlock(piece.kind);
          if (piece.kind === "thinking") {
            thoughtChars += piece.text.length;
          } else {
            outputText += piece.text;
          }
          controller.enqueue(
            sse("content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta:
                piece.kind === "thinking"
                  ? { type: "thinking_delta", thinking: piece.text }
                  : { type: "text_delta", text: piece.text },
            }),
          );
        }
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
              usage: { input_tokens: promptToken, output_tokens: 0 },
            },
          }),
        );
        controller.enqueue(sse("ping", { type: "ping" }));

        for await (const event of invokeFitted(payload, signal)) {
          if (signal.aborted) break;

          if (event.type === "assistantResponse") {
            const chunk = event.data.content ?? "";
            if (!chunk) continue;
            if (!firstTextAt) firstTextAt = performance.now();
            chunkCount++;
            writePieces(splitter ? splitter.push(chunk) : [{ kind: "text", text: chunk }]);
            continue;
          }

          if (event.type === "reasoning") {
            const { text, signature } = event.data;
            if (!firstTextAt) firstTextAt = performance.now();
            if (text) writePieces([{ kind: "thinking", text }]);
            // The signature closes the block it belongs to. A model that chose
            // not to think sends one with no text; there is no block to sign.
            if (signature && open?.kind === "thinking") {
              controller.enqueue(
                sse("content_block_delta", {
                  type: "content_block_delta",
                  index: open.index,
                  delta: { type: "signature_delta", signature },
                }),
              );
            }
            continue;
          }

          if (event.type === "toolUse") {
            const { toolUseId, name, input, stop } = event.data;
            sawToolUse = true;

            // Reasoning left open when the model turns to a tool call ends here:
            // it did end, it just ended without saying so.
            if (splitter) writePieces(splitter.end());

            if (!(open?.kind === "tool" && open.id === toolUseId)) {
              closeOpen();
              open = { kind: "tool", index: nextIndex++, id: toolUseId };
              toolIds.add(toolUseId);
              controller.enqueue(
                sse("content_block_start", {
                  type: "content_block_start",
                  index: open.index,
                  content_block: { type: "tool_use", id: toolUseId, name, input: {} },
                }),
              );
            }

            if (input) {
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

          if (event.type === "contextUsage") {
            contextPercent = event.data.contextUsagePercentage ?? contextPercent;
            continue;
          }

          if (event.type === "metering") {
            credits += event.data.usage ?? 0;
            continue;
          }

          if (event.type === "metadata") refusal = refusalOf(event.data) ?? refusal;

          if (event.type === "metadata" && event.data.stopReason) {
            stopReason = event.data.stopReason;
          }
        }

        if (splitter) writePieces(splitter.end());
        closeOpen();

        // A refusal ends the stream like any answer, just with nothing in it.
        // Passed on as-is it reads as "the model returned no content" and
        // hides the reason, so it becomes an error that says what happened.
        if (!outputText && !thoughtChars && !sawToolUse) {
          dumpEmpty(payload, refusal ?? `stop=${stopReason ?? "none"}`);
          if (refusal) throw new Error(refusal);
        }

        const outputTokens = estimateTokens(outputText) + Math.ceil(thoughtChars / 4) + toolIds.size * 8;
        // The prompt as the service counted it, replacing the estimate
        // message_start had to give before anything was known, split by what
        // the service's cache held (kiro/cache.ts). Planned from the payload
        // as finally sent: a refit trims it in place.
        const usage = usageOf(
          promptFromContext(contextPercent, outputTokens) ?? promptToken,
          outputTokens,
          planOf(payload),
        );
        controller.enqueue(
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: mapStopReason(stopReason, sawToolUse), stop_sequence: null },
            usage,
          }),
        );
        controller.enqueue(sse("message_stop", { type: "message_stop" }));
        log.info(
          `stream completed model=${model} ttfb=${Math.round(firstTextAt ? firstTextAt - startedAt : -1)}ms ` +
            `total=${Math.round(performance.now() - startedAt)}ms chunks=${chunkCount} thought=${thoughtChars} ` +
            `credits=${credits.toFixed(4)} prompt=${usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)} ` +
            `read=${usage.cache_read_input_tokens ?? 0} write=${usage.cache_creation_input_tokens ?? 0}`,
        );
      } catch (error) {
        const message = overflowed(error)
          ? overflowMessage(error as KiroApiError)
          : error instanceof Error
            ? error.message
            : String(error);
        log.error(`stream failed: ${message}`);
        // The HTTP status is already 200 by this point, so the failure has to be
        // reported inside the stream where the client will actually see it.
        controller.enqueue(
          sse("error", {
            type: "error",
            error: {
              type: overflowed(error)
                ? "invalid_request_error"
                : error instanceof KiroApiError
                  ? "api_error"
                  : "internal_server_error",
              message,
            },
          }),
        );
      } finally {
        alive = false;
        clearInterval(heartbeat);
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
