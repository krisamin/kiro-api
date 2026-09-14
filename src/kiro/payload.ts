import type { MessagesRequest } from "../anthropic/type.ts";
import { MAX_PAYLOAD_BYTES } from "../core/config.ts";
import { log } from "../core/log.ts";
import { convertTools, type NormalMessage, normalizeMessages, systemText } from "./convert.ts";
import { THINKING_INSTRUCTION, thinkingAsked } from "./thinking.ts";
import type { KiroHistoryEntry, KiroPayload, KiroUserInputMessage } from "./type.ts";

/**
 * What to say when a turn has no words of its own.
 *
 * ★Only the *current* message needs this, and only when it is empty in every
 * way. Empty `content` was treated as a 400 anywhere in the conversation, so
 * every wordless turn - which in an agent conversation is most of them, a tool
 * call one way and its result the other - carried a placeholder into the
 * prompt. The model reads its own history, and a transcript full of "(empty
 * placeholder)" eventually gets it written into an answer, which is how this
 * was noticed.
 *
 * Measured: empty `content` is accepted on history entries (assistant and
 * user), and on the current message when it carries tool results. The one
 * rejection is a current message with nothing at all - no text, no images, no
 * tool results - which happens when the client's last turn is the assistant's
 * and a user turn has to be invented to carry the request. "Continue." is what
 * that invented turn actually means.
 */
const CONTINUE_TEXT = "Continue.";

const byteLength = (payload: KiroPayload): number => Buffer.byteLength(JSON.stringify(payload), "utf8");

const buildUserMessage = (msg: NormalMessage, modelId: string): KiroUserInputMessage => {
  const out: KiroUserInputMessage = {
    content: msg.text,
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

/**
 * Drop the oldest turns until the serialized payload fits Kiro's size ceiling.
 *
 * Each entry is measured once and the running total is decremented as entries
 * are dropped, rather than re-serializing the whole payload per iteration
 * (which is O(n^2) and cost ~1s on a 4000-turn conversation). The envelope is
 * derived by subtracting the measured entries from one full measurement, so the
 * total stays exact rather than estimated.
 */
const trimToLimit = (payload: KiroPayload): boolean => {
  const history = payload.conversationState.history;
  if (!history || history.length === 0) return false;

  const beforeEntries = history.length;
  const totalBefore = byteLength(payload);

  // `,` between array elements is part of the serialized form.
  const sizes = history.map((entry) => Buffer.byteLength(JSON.stringify(entry), "utf8") + 1);
  const envelope = totalBefore - sizes.reduce((sum, size) => sum + size, 0);

  let running = totalBefore;
  let dropped = 0;
  while (history.length - dropped > 2 && running > MAX_PAYLOAD_BYTES) {
    running -= (sizes[dropped] as number) + (sizes[dropped + 1] as number);
    dropped += 2;
  }
  // History must still start on a user turn after trimming.
  while (dropped < history.length && !(history[dropped] && "userInputMessage" in (history[dropped] as object))) {
    running -= sizes[dropped] as number;
    dropped++;
  }
  if (dropped > 0) history.splice(0, dropped);

  repairOrphanToolResults(history);

  if (history.length === 0) {
    delete payload.conversationState.history;
    running = envelope;
  }

  log.info(`trimmed history: ${beforeEntries} -> ${history.length} entries (${totalBefore} -> ${running} bytes)`);
  return dropped > 0;
};

/**
 * Put the system prompt at the front of the conversation.
 *
 * Kiro has no system role, so the prompt lives on the earliest user turn. That
 * turn is also the first thing trimming throws away, which took the system
 * prompt with it: a conversation long enough to trim silently lost the agent's
 * entire instructions, and the answers after that came from a model with no
 * idea who it was. So this runs again after trimming, onto whatever turn is
 * earliest now - the current message if history is gone entirely.
 */
const attachSystem = (payload: KiroPayload, system: string): void => {
  const history = payload.conversationState.history ?? [];
  const firstUser = history.find((entry) => "userInputMessage" in entry);
  const target =
    firstUser && "userInputMessage" in firstUser
      ? firstUser.userInputMessage
      : payload.conversationState.currentMessage.userInputMessage;
  target.content = target.content ? `${system}\n\n${target.content}` : system;
};

export const buildPayload = (
  request: MessagesRequest,
  modelId: string,
  profileArn: string | undefined,
  conversationId: string,
): KiroPayload => {
  const { tools, documentation } = convertTools(request.tools);
  const hasTools = tools.length > 0;

  let system = systemText(request.system);
  if (documentation) system = system ? system + documentation : documentation.trim();
  // Reasoning is asked for here and parsed back out of the answer; the service
  // has no parameter for it. See kiro/thinking.ts for why it is not a tool.
  if (thinkingAsked(request)) {
    system = system ? `${system}\n\n${THINKING_INSTRUCTION}` : THINKING_INSTRUCTION;
  }

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
          content: msg.text,
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
        content: currentMessage.text,
        ...(currentMessage.toolUses.length > 0 ? { toolUses: currentMessage.toolUses } : {}),
      },
    });
    current.content = "";
    delete current.images;
  }

  // The one turn Kiro will not take empty: a current message with nothing
  // in it at all. Everything else keeps its own silence.
  if (!current.content && !current.images?.length && !current.userInputMessageContext?.toolResults?.length) {
    current.content = CONTINUE_TEXT;
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

  // Trimming drops the oldest turns, and the oldest turn is the one holding the
  // system prompt, so it goes back on whatever turn is earliest afterwards.
  if (byteLength(payload) > MAX_PAYLOAD_BYTES && trimToLimit(payload) && system) {
    attachSystem(payload, system);
  }

  return payload;
};
