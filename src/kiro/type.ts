/** Kiro `generateAssistantResponse` wire shapes (AWS CodeWhisperer streaming). */

export type KiroImage = { format: string; source: { bytes: string } };

export type KiroToolSpec = {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
};

export type KiroToolResult = {
  toolUseId: string;
  content: Array<{ text: string }>;
  status: "success" | "error";
};

export type KiroToolUse = {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
};

export type KiroUserInputMessage = {
  content: string;
  modelId: string;
  origin: "AI_EDITOR";
  images?: KiroImage[];
  userInputMessageContext?: {
    tools?: KiroToolSpec[];
    toolResults?: KiroToolResult[];
  };
};

export type KiroAssistantMessage = {
  content: string;
  toolUses?: KiroToolUse[];
};

export type KiroHistoryEntry =
  | { userInputMessage: KiroUserInputMessage }
  | { assistantResponseMessage: KiroAssistantMessage };

export type KiroPayload = {
  profileArn?: string;
  conversationState: {
    chatTriggerType: "MANUAL";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
};

/** Event payloads carried inside the AWS event-stream frames. */

export type AssistantResponseEvent = { content?: string; modelId?: string };

export type ToolUseEvent = {
  toolUseId: string;
  name: string;
  /** Partial JSON fragment of the tool input; concatenate across events. */
  input?: string;
  stop?: boolean;
};

export type MetadataEvent = { stopReason?: string; conversationId?: string };

export type ContextUsageEvent = { contextUsagePercentage?: number };

export type MeteringEvent = { unit?: string; unitPlural?: string; usage?: number };

export type KiroEvent =
  | { type: "assistantResponse"; data: AssistantResponseEvent }
  | { type: "toolUse"; data: ToolUseEvent }
  | { type: "metadata"; data: MetadataEvent }
  | { type: "contextUsage"; data: ContextUsageEvent }
  | { type: "metering"; data: MeteringEvent }
  | { type: "error"; data: { message: string; name?: string } }
  | { type: "unknown"; name: string; data: unknown };
