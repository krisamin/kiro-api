import type { AnthropicContentBlock, AnthropicMessage, AnthropicSystem, AnthropicTool } from "../anthropic/type.ts";
import { MAX_TOOL_DESCRIPTION, MAX_TOOL_NAME } from "../core/config.ts";
import type { KiroImage, KiroToolResult, KiroToolSpec, KiroToolUse } from "./type.ts";

/**
 * Anthropic -> Kiro payload conversion.
 *
 * Kiro's `generateAssistantResponse` is not an Anthropic-shaped API: it takes a
 * `conversationState` with a strictly alternating history and a single current
 * message. Every normalisation below exists because Kiro answers a violation
 * with the same opaque 400 ("Improperly formed request"), so the constraints are
 * enforced here rather than discovered at runtime.
 */

export const textOf = (content: string | AnthropicContentBlock[] | undefined): string => {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "thinking" && block.thinking) parts.push(block.thinking);
  }
  return parts.join("\n");
};

export const systemText = (system: AnthropicSystem | undefined): string => {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
};

export const imagesOf = (content: string | AnthropicContentBlock[] | undefined): KiroImage[] => {
  if (!content || typeof content === "string") return [];
  const images: KiroImage[] = [];
  for (const block of content) {
    if (block.type !== "image") continue;
    const source = block.source;
    if (source.type !== "base64") continue;
    let data = source.data;
    let mediaType = source.media_type;
    // Some clients inline a full data URL in `data`; Kiro wants raw base64.
    if (data.startsWith("data:")) {
      const comma = data.indexOf(",");
      if (comma !== -1) {
        const header = data.slice(5, comma).split(";")[0];
        if (header) mediaType = header;
        data = data.slice(comma + 1);
      }
    }
    if (!data) continue;
    images.push({
      format: mediaType.includes("/") ? (mediaType.split("/").pop() as string) : mediaType,
      source: { bytes: data },
    });
  }
  return images;
};

export const toolUsesOf = (content: string | AnthropicContentBlock[] | undefined): KiroToolUse[] => {
  if (!content || typeof content === "string") return [];
  const uses: KiroToolUse[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    uses.push({ toolUseId: block.id, name: block.name, input: block.input ?? {} });
  }
  return uses;
};

export const toolResultsOf = (content: string | AnthropicContentBlock[] | undefined): KiroToolResult[] => {
  if (!content || typeof content === "string") return [];
  const results: KiroToolResult[] = [];
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const text = typeof block.content === "string" ? block.content : textOf(block.content);
    results.push({
      toolUseId: block.tool_use_id,
      content: [{ text: text || "(empty result)" }],
      status: block.is_error ? "error" : "success",
    });
  }
  return results;
};

/**
 * Strip JSON Schema keywords Kiro rejects.
 *
 * An empty `required: []` and any `additionalProperties` both trigger a 400,
 * and they can appear at any nesting depth, so this recurses.
 */
export const sanitizeSchema = (schema: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!schema) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue;
    if (key === "required" && Array.isArray(value) && value.length === 0) continue;
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        typeof item === "object" && item !== null ? sanitizeSchema(item as Record<string, unknown>) : item,
      );
    } else if (typeof value === "object" && value !== null) {
      out[key] = sanitizeSchema(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
};

export type ToolConversion = { tools: KiroToolSpec[]; documentation: string };

/**
 * Convert tools, moving oversized descriptions into the system prompt.
 *
 * Kiro 400s when a tool description is too long, so long ones are replaced with
 * a pointer and the full text is appended to the system prompt instead.
 */
export const convertTools = (tools: AnthropicTool[] | undefined): ToolConversion => {
  if (!tools || tools.length === 0) return { tools: [], documentation: "" };

  const converted: KiroToolSpec[] = [];
  const docs: string[] = [];

  for (const tool of tools) {
    if (tool.name.length > MAX_TOOL_NAME) {
      throw new Error(`Tool name "${tool.name}" exceeds Kiro's ${MAX_TOOL_NAME} character limit`);
    }

    const original = tool.description?.trim() ?? "";
    let description = original || `Tool: ${tool.name}`;

    if (description.length > MAX_TOOL_DESCRIPTION) {
      docs.push(`## Tool: ${tool.name}\n\n${description}`);
      description = `[Full documentation in system prompt under '## Tool: ${tool.name}']`;
    }

    converted.push({
      toolSpecification: {
        name: tool.name,
        description,
        inputSchema: { json: sanitizeSchema(tool.input_schema) },
      },
    });
  }

  const documentation = docs.length > 0 ? `\n\n---\n\n# Tool Documentation\n\n${docs.join("\n\n")}` : "";
  return { tools: converted, documentation };
};

export type NormalMessage = {
  role: "user" | "assistant";
  text: string;
  images: KiroImage[];
  toolUses: KiroToolUse[];
  toolResults: KiroToolResult[];
};

const hasPayload = (msg: NormalMessage): boolean =>
  msg.text.length > 0 || msg.images.length > 0 || msg.toolUses.length > 0 || msg.toolResults.length > 0;

/**
 * Flatten Anthropic messages into Kiro's model, then enforce its structural
 * rules: known roles only, user first, strict user/assistant alternation.
 */
export const normalizeMessages = (messages: AnthropicMessage[], keepTools: boolean): NormalMessage[] => {
  const flat: NormalMessage[] = messages.map((msg) => ({
    // Kiro only understands user/assistant; anything else (e.g. "developer")
    // becomes a user turn rather than being dropped.
    role: msg.role === "assistant" ? "assistant" : "user",
    text: textOf(msg.content),
    images: imagesOf(msg.content),
    toolUses: keepTools ? toolUsesOf(msg.content) : [],
    toolResults: keepTools ? toolResultsOf(msg.content) : [],
  }));

  // When the caller sent no tools, Kiro rejects any lingering tool traffic.
  // Fold it into plain text so the conversation still reads correctly.
  if (!keepTools) {
    for (let i = 0; i < flat.length; i++) {
      const source = messages[i];
      const msg = flat[i];
      if (!source || !msg) continue;
      const uses = toolUsesOf(source.content);
      const results = toolResultsOf(source.content);
      const extra: string[] = [];
      for (const use of uses) extra.push(`[tool call: ${use.name}(${JSON.stringify(use.input)})]`);
      for (const result of results) extra.push(`[tool result: ${result.content[0]?.text ?? ""}]`);
      if (extra.length > 0) msg.text = [msg.text, ...extra].filter(Boolean).join("\n");
    }
  }

  const merged: NormalMessage[] = [];
  for (const msg of flat) {
    if (!hasPayload(msg)) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      // Adjacent same-role turns must be merged; Kiro requires alternation.
      prev.text = [prev.text, msg.text].filter(Boolean).join("\n");
      prev.images.push(...msg.images);
      prev.toolUses.push(...msg.toolUses);
      prev.toolResults.push(...msg.toolResults);
    } else {
      merged.push({ ...msg, images: [...msg.images], toolUses: [...msg.toolUses], toolResults: [...msg.toolResults] });
    }
  }

  // History must begin with a user turn.
  while (merged.length > 0 && merged[0]?.role !== "user") merged.shift();

  return merged;
};
