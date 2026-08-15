/**
 * AWS event-stream (`application/vnd.amazon.eventstream`) frame decoder.
 *
 * Frame layout:
 *   [4] total length      big-endian uint32, includes every byte of the frame
 *   [4] headers length    big-endian uint32
 *   [4] prelude CRC32     over the preceding 8 bytes
 *   [n] headers           see decodeHeader below
 *   [m] payload           total - 12 - headersLen - 4
 *   [4] message CRC32     over every byte before it
 *
 * Kiro streams these frames for `generateAssistantResponse`. We parse the real
 * framing instead of scraping JSON out of the byte soup, so a payload that
 * happens to contain braces or partial UTF-8 can never desync the stream.
 */

export type EventFrame = {
  headers: Record<string, string>;
  payload: Uint8Array;
};

/** AWS header value type tags. Kiro only ever emits string (7). */
const HEADER_TYPE_STRING = 7;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] as number;
    c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const decodeHeaders = (buf: Uint8Array): Record<string, string> => {
  const headers: Record<string, string> = {};
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const decoder = new TextDecoder();
  let off = 0;

  while (off < buf.length) {
    const nameLen = buf[off] as number;
    off += 1;
    if (off + nameLen > buf.length) break;
    const name = decoder.decode(buf.subarray(off, off + nameLen));
    off += nameLen;

    const valueType = buf[off] as number;
    off += 1;

    if (valueType === HEADER_TYPE_STRING) {
      if (off + 2 > buf.length) break;
      const valueLen = view.getUint16(off, false);
      off += 2;
      headers[name] = decoder.decode(buf.subarray(off, off + valueLen));
      off += valueLen;
    } else {
      // Non-string header types are not emitted by Kiro. Bail out rather than
      // guess at a length and desync the rest of the header block.
      break;
    }
  }

  return headers;
};

/**
 * Incremental frame decoder.
 *
 * Feed arbitrary chunks from the HTTP body; complete frames come back in order.
 * Partial frames are buffered until the remaining bytes arrive, which is what
 * makes this safe for streaming responses.
 */
export class EventStreamDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): EventFrame[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const frames: EventFrame[] = [];
    let offset = 0;

    while (this.buffer.length - offset >= 16) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, this.buffer.length - offset);
      const totalLen = view.getUint32(0, false);
      const headersLen = view.getUint32(4, false);

      // Guard against a corrupt prelude claiming an absurd size.
      if (totalLen < 16 || totalLen > 100 * 1024 * 1024) {
        throw new Error(`event-stream: implausible frame length ${totalLen}`);
      }
      if (this.buffer.length - offset < totalLen) break;

      const frame = this.buffer.subarray(offset, offset + totalLen);

      const preludeCrc = view.getUint32(8, false);
      if (crc32(frame.subarray(0, 8)) !== preludeCrc) {
        throw new Error("event-stream: prelude CRC mismatch");
      }
      const messageCrc = view.getUint32(totalLen - 4, false);
      if (crc32(frame.subarray(0, totalLen - 4)) !== messageCrc) {
        throw new Error("event-stream: message CRC mismatch");
      }

      const headerBytes = frame.subarray(12, 12 + headersLen);
      const payload = frame.subarray(12 + headersLen, totalLen - 4);

      frames.push({ headers: decodeHeaders(headerBytes), payload });
      offset += totalLen;
    }

    this.buffer = offset > 0 ? this.buffer.slice(offset) : this.buffer;
    return frames;
  }

  /** Bytes buffered but not yet forming a complete frame. */
  get pending(): number {
    return this.buffer.length;
  }
}
