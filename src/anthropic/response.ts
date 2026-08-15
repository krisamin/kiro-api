import { randomUUID } from "node:crypto";
import type { KiroEvent } from "../kiro/type.ts";
import type { AnthropicContentBlock, AnthropicUsage, MessagesResponse, StopReason } from "./type.ts";

/**
 * Aggregates Kiro's event stream into Anthropic content blocks.
 *
 * Kiro emits tool input as a sequence of partial JSON fragments terminated by a
 * `stop` event, which lines up with Anthropic's `input_json_delta`. Text arrives
 * as plain chunks. This class is the single place that reassembles both, so the
 * streaming and non-streaming responses cannot drift apart.
 */

export type ToolAccumulator = {
  id: string;
  name: string;
  json: string;
};

export const messageId = (): string => `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

export const mapStopReason = (kiroReason: string | undefined, sawToolUse: boolean): StopReason => {
  if (sawToolUse) return "tool_use";
  switch (kiroReason) {
    case "END_TURN":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "TOOL_USE":
      return "tool_use";
    default:
      return "end_turn";
  }
};

/**
 * Rough token estimate.
 *
 * Kiro reports usage as opaque credits, not tokens, so exact counts are not
 * available. Clients (including Hermes) still expect the usage field to exist,
 * so we approximate at ~4 characters per token and label it clearly rather than
 * inventing precise-looking numbers.
 */
export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export class ResponseBuilder {
  private readonly texts: string[] = [];
  private readonly tools = new Map<string, ToolAccumulator>();
  private order: Array<{ kind: "text"; value: string } | { kind: "tool"; id: string }> = [];
  private stopReason: string | undefined;
  private creditUsage = 0;
  private contextPercent = 0;

  /** Feed one decoded Kiro event. Returns the accumulator if a tool was touched. */
  accept(event: KiroEvent): void {
    switch (event.type) {
      case "assistantResponse": {
        const chunk = event.data.content ?? "";
        if (!chunk) break;
        this.texts.push(chunk);
        const last = this.order[this.order.length - 1];
        if (last?.kind === "text") last.value += chunk;
        else this.order.push({ kind: "text", value: chunk });
        break;
      }
      case "toolUse": {
        const { toolUseId, name, input } = event.data;
        let acc = this.tools.get(toolUseId);
        if (!acc) {
          acc = { id: toolUseId, name, json: "" };
          this.tools.set(toolUseId, acc);
          this.order.push({ kind: "tool", id: toolUseId });
        }
        if (input) acc.json += input;
        break;
      }
      case "metadata":
        if (event.data.stopReason) this.stopReason = event.data.stopReason;
        break;
      case "metering":
        this.creditUsage += event.data.usage ?? 0;
        break;
      case "contextUsage":
        this.contextPercent = event.data.contextUsagePercentage ?? this.contextPercent;
        break;
      default:
        break;
    }
  }

  get credits(): number {
    return this.creditUsage;
  }

  get contextUsagePercent(): number {
    return this.contextPercent;
  }

  get sawToolUse(): boolean {
    return this.tools.size > 0;
  }

  get text(): string {
    return this.texts.join("");
  }

  blocks(): AnthropicContentBlock[] {
    const out: AnthropicContentBlock[] = [];
    for (const item of this.order) {
      if (item.kind === "text") {
        if (item.value) out.push({ type: "text", text: item.value });
      } else {
        const acc = this.tools.get(item.id);
        if (!acc) continue;
        out.push({ type: "tool_use", id: acc.id, name: acc.name, input: parseToolInput(acc.json) });
      }
    }
    return out;
  }

  usage(promptText: string): AnthropicUsage {
    return {
      input_tokens: estimateTokens(promptText),
      output_tokens: estimateTokens(this.text) + this.tools.size * 8,
    };
  }

  response(model: string, promptText: string): MessagesResponse {
    return {
      id: messageId(),
      type: "message",
      role: "assistant",
      model,
      content: this.blocks(),
      stop_reason: mapStopReason(this.stopReason, this.sawToolUse),
      stop_sequence: null,
      usage: this.usage(promptText),
    };
  }
}

/**
 * Parse accumulated tool-input JSON.
 *
 * A truncated stream can leave invalid JSON behind; an empty object is a better
 * outcome for the client than a thrown error mid-response.
 */
export const parseToolInput = (json: string): Record<string, unknown> => {
  const trimmed = json.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
