import type { MessagesRequest } from "../anthropic/type.ts";

/**
 * Extended thinking, on a service that has no such parameter.
 *
 * Kiro's `generateAssistantResponse` has no reasoning field and emits no
 * reasoning event: a request carrying Anthropic's `thinking` block comes back
 * as an ordinary answer. So the reasoning has to be asked for in the prompt and
 * recovered from the text.
 *
 * The first build did it with a tool, the way kiro-cli's own experimental
 * thinking works (`chat.enableThinking`): offer a `thinking` tool, report the
 * call as a thinking block, feed the result back and continue. It called the
 * tool reliably - and then said nothing at all. Measured five ways: a turn whose
 * last assistant message was a call to a *reasoning* tool came back empty every
 * time (0 content blocks), while the same continuation with a weather tool
 * answered normally. Renaming the tool did not help and neither did the tool
 * result's wording; swapping the tool's purpose did. The model treats "I have
 * written my reasoning down" as having finished its turn.
 *
 * A tagged block has none of that problem: the model keeps writing, reasoning
 * and answer arrive in one stream, and it costs one call instead of two.
 * Measured on the same questions, the tags came out on every reply including
 * trivial ones, and alongside a real tool call when one was due.
 */

export const THINKING_OPEN = "<thinking>";
export const THINKING_CLOSE = "</thinking>";

/**
 * What makes the model produce the block.
 *
 * "Never use those tags anywhere else" is the line that keeps the split honest:
 * the parser cannot tell a quoted tag from a real one, so the tag is declared
 * reserved rather than escaped.
 */
export const THINKING_INSTRUCTION =
  `Extended thinking is on. Start every reply with your reasoning wrapped in ` +
  `${THINKING_OPEN} and ${THINKING_CLOSE}, and write the answer after it. The person reads ` +
  `only what comes after the closing tag, so the answer has to stand on its own without ` +
  `referring back to the reasoning. Never nest the tags and never use them anywhere else.`;

/** Whether this request asked for thinking. */
export const thinkingAsked = (request: MessagesRequest): boolean => request.thinking?.type === "enabled";

export type ThinkingPiece = { kind: "text" | "thinking"; text: string };

/** How much of `text`'s tail could still turn into `needle` once more arrives. */
const danglingLength = (text: string, needle: string): number => {
  const most = Math.min(needle.length - 1, text.length);
  for (let length = most; length > 0; length--) {
    if (needle.startsWith(text.slice(text.length - length))) {
      return length;
    }
  }
  return 0;
};

/**
 * Splits a stream of text into reasoning and answer.
 *
 * A tag can arrive across two chunks (`<thin` then `king>`), so whatever tail of
 * the buffer could still become one is held back rather than emitted as text -
 * the whole reason this is a class and not a regex over the finished answer.
 */
export class ThinkingSplitter {
  private buffer = "";
  private inside = false;
  private started = false;

  /** Feed a chunk; get back the pieces that are now certain. */
  push(chunk: string): ThinkingPiece[] {
    this.buffer += chunk;
    const pieceList: ThinkingPiece[] = [];
    for (;;) {
      const needle = this.inside ? THINKING_CLOSE : THINKING_OPEN;
      const at = this.buffer.indexOf(needle);
      if (at >= 0) {
        this.emit(pieceList, this.buffer.slice(0, at));
        this.buffer = this.buffer.slice(at + needle.length);
        this.inside = !this.inside;
        this.started = false;
        continue;
      }
      const dangling = danglingLength(this.buffer, needle);
      this.emit(pieceList, this.buffer.slice(0, this.buffer.length - dangling));
      this.buffer = dangling > 0 ? this.buffer.slice(this.buffer.length - dangling) : "";
      return pieceList;
    }
  }

  /** Close the stream: whatever is still held back was text after all. */
  end(): ThinkingPiece[] {
    const pieceList: ThinkingPiece[] = [];
    this.emit(pieceList, this.buffer);
    this.buffer = "";
    return pieceList;
  }

  private emit(pieceList: ThinkingPiece[], text: string): void {
    if (!text) {
      return;
    }
    const kind = this.inside ? "thinking" : "text";
    // The newlines between a closing tag and the answer are the prompt's
    // formatting, not the answer's. Trimmed once per block, so blank lines
    // inside an answer survive.
    const value = this.started ? text : text.replace(/^\s+/, "");
    if (!value) {
      return;
    }
    this.started = true;
    const last = pieceList[pieceList.length - 1];
    if (last && last.kind === kind) {
      last.text += value;
      return;
    }
    pieceList.push({ kind, text: value });
  }
}

/** Split finished text in one go - the non-streaming path. */
export const splitThinking = (text: string): ThinkingPiece[] => {
  const splitter = new ThinkingSplitter();
  return [...splitter.push(text), ...splitter.end()];
};
