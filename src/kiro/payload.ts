import type { MessagesRequest } from "../anthropic/type.ts";
import { MAX_PAYLOAD_BYTES } from "../core/config.ts";
import { log } from "../core/log.ts";
import { convertTools, type NormalMessage, normalizeMessages, systemText } from "./convert.ts";
import type { KiroHistoryEntry, KiroPayload, KiroUserInputMessage } from "./type.ts";

const EMPTY_PLACEHOLDER = "(empty placeholder)";

const byteLength = (payload: KiroPayload): number => Buffer.byteLength(JSON.stringify(payload), "utf8");

const buildUserMessage = (msg: NormalMessage, modelId: string): KiroUserInputMessage => {
  const out: KiroUserInputMessage = {
    content: msg.text || EMPTY_PLACEHOLDER,
    modelId,
    origin: "AI_EDITOR",
  };
  // Images belong directly on userInputMessage, not inside the context object.
  if (msg.images.length > 0) out.images = msg.images;
  if (msg.toolResults.length > 0) out.userInputMessageContext = { toolResults: msg.toolResults };
  return out;
};

/**
 * Drop tool results whose matching tool_use is not in the immediately preceding
 * assistant turn. Trimming history can orphan them, and Kiro 400s on orphans, so
 * the text is preserved inline instead of being silently lost.
 */
const repairOrphanToolResults = (history: KiroHistoryEntry[]): void => {
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry || !("userInputMessage" in entry)) continue;
    const ctx = entry.userInputMessage.userInputMessageContext;
    if (!ctx?.toolResults) continue;

    const prev = i > 0 ? history[i - 1] : undefined;
    const validIds = new Set<string>();
    if (prev && "assistantResponseMessage" in prev) {
      for (const use of prev.assistantResponseMessage.toolUses ?? []) validIds.add(use.toolUseId);
    }

    const kept = ctx.toolResults.filter((tr) => validIds.has(tr.toolUseId));
    if (kept.length === ctx.toolResults.length) continue;

    const orphanText = ctx.toolResults
      .filter((tr) => !validIds.has(tr.toolUseId))
      .map((tr) => tr.content[0]?.text ?? "")
      .filter(Boolean)
      .join("; ");

    if (kept.length > 0) {
      ctx.toolResults = kept;
    } else {
      delete ctx.toolResults;
      if (Object.keys(ctx).length === 0) delete entry.userInputMessage.userInputMessageContext;
    }
    if (orphanText) {
      entry.userInputMessage.content = `${entry.userInputMessage.content}\n[trimmed tool result] ${orphanText}`;
    }
  }
};

/** Drop the oldest turns until the serialized payload fits Kiro's size ceiling. */
const trimToLimit = (payload: KiroPayload): void => {
  const history = payload.conversationState.history;
  if (!history || history.length === 0) return;

  const before = { entries: history.length, bytes: byteLength(payload) };

  // Remove user/assistant pairs from the front.
  while (history.length > 2 && byteLength(payload) > MAX_PAYLOAD_BYTES) {
    history.splice(0, 2);
  }
  // History must still start on a user turn after trimming.
  while (history.length > 0 && !(history[0] && "userInputMessage" in history[0])) history.shift();

  repairOrphanToolResults(history);

  if (history.length === 0) delete payload.conversationState.history;

  log.info(
    `trimmed history: ${before.entries} -> ${history.length} entries (${before.bytes} -> ${byteLength(payload)} bytes)`,
  );
};

export type BuiltPayload = { payload: KiroPayload; modelId: string };

export const buildPayload = (
  request: MessagesRequest,
  modelId: string,
  profileArn: string | undefined,
  conversationId: string,
): BuiltPayload => {
  const { tools, documentation } = convertTools(request.tools);
  const hasTools = tools.length > 0;

  let system = systemText(request.system);
  if (documentation) system = system ? system + documentation : documentation.trim();

  const messages = normalizeMessages(request.messages, hasTools);
  if (messages.length === 0) throw new Error("No messages to send");

  const historyMessages = messages.slice(0, -1);
  const currentMessage = messages[messages.length - 1] as NormalMessage;

  // Kiro has no system role: the prompt is prepended to the earliest user turn
  // so it stays at the front of the conversation.
  if (system) {
    const firstUser = historyMessages[0] ?? currentMessage;
    firstUser.text = `${system}\n\n${firstUser.text}`;
  }

  const history: KiroHistoryEntry[] = [];
  for (const msg of historyMessages) {
    if (msg.role === "user") {
      history.push({ userInputMessage: buildUserMessage(msg, modelId) });
    } else {
      const assistant: KiroHistoryEntry = {
        assistantResponseMessage: {
          content: msg.text || EMPTY_PLACEHOLDER,
          // An empty toolUses array is itself a 400; only attach a populated one.
          ...(msg.toolUses.length > 0 ? { toolUses: msg.toolUses } : {}),
        },
      };
      history.push(assistant);
    }
  }

  const current = buildUserMessage(currentMessage, modelId);
  if (hasTools) {
    current.userInputMessageContext = { ...(current.userInputMessageContext ?? {}), tools };
  }

  // The final turn must be a user turn; fold a trailing assistant into history.
  if (currentMessage.role === "assistant") {
    history.push({
      assistantResponseMessage: {
        content: currentMessage.text || EMPTY_PLACEHOLDER,
        ...(currentMessage.toolUses.length > 0 ? { toolUses: currentMessage.toolUses } : {}),
      },
    });
    current.content = EMPTY_PLACEHOLDER;
    delete current.images;
  }

  const payload: KiroPayload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: { userInputMessage: current },
      ...(history.length > 0 ? { history } : {}),
    },
    ...(profileArn ? { profileArn } : {}),
  };

  if (byteLength(payload) > MAX_PAYLOAD_BYTES) trimToLimit(payload);

  return { payload, modelId };
};
