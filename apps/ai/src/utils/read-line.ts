import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/**
 * One line from a stream, or `null` when the stream ends without one.
 *
 * The line has to be handed over before the reader is closed: closing it emits "close" right
 * away, and that event settles the promise with `null` before the line is ever delivered. That
 * silent order is why the pasted key used to look like nothing had been pasted at all.
 */
export function readLine(input: Readable = process.stdin): Promise<string | null> {
  return new Promise((resolve) => {
    let received: string | null = null;
    const reader = createInterface({ input });
    reader.once("line", (line) => {
      received = line;
      resolve(line);
      reader.close();
    });
    reader.once("close", () => {
      if (received === null) resolve(null);
    });
  });
}

/**
 * The key the person pasted, or `null` when nothing usable was pasted.
 *
 * A blank line counts as nothing: the sign-in has to say what is missing instead of sending an
 * empty credential to the vendor.
 */
export async function readPastedKey(input: Readable = process.stdin): Promise<string | null> {
  const line = await readLine(input);
  const trimmed = line?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
