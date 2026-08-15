/** Anthropic Messages API surface — the shape we expose to clients. */

export type AnthropicTextBlock = { type: "text"; text: string };

export type AnthropicThinkingBlock = { type: "thinking"; thinking: string; signature?: string };

export type AnthropicImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
};

export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export type AnthropicMessage = {
  role: "user" | "assistant" | string;
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
};

export type AnthropicSystem = string | Array<{ type: string; text?: string }>;

export type MessagesRequest = {
  model: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystem;
  tools?: AnthropicTool[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  metadata?: Record<string, unknown>;
};

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export type AnthropicUsage = { input_tokens: number; output_tokens: number };

export type MessagesResponse = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: StopReason | null;
  stop_sequence: null;
  usage: AnthropicUsage;
};
