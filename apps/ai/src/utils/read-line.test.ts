import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { readLine, readPastedKey } from "./read-line";

/**
 * The reader is closed as soon as the line arrives, and closing it emits "close" right away. The
 * line has to be handed over before that happens, or the promise settles with `null` and a key
 * that was really pasted looks like nothing was pasted at all.
 */
test("reads the line that was pasted even though the reader closes right after", async () => {
  const input = Readable.from(["sk-cp-pasted-key\n"]);
  assert.equal(await readLine(input), "sk-cp-pasted-key");
});

test("reads a line that arrives without a trailing newline", async () => {
  const input = Readable.from(["sk-cp-pasted-key"]);
  assert.equal(await readLine(input), "sk-cp-pasted-key");
});

test("reads only the first line", async () => {
  const input = Readable.from(["first\nsecond\n"]);
  assert.equal(await readLine(input), "first");
});

test("reports no line when the input ends without one", async () => {
  const input = Readable.from([]);
  assert.equal(await readLine(input), null);
});

test("returns the pasted key without the spaces around it", async () => {
  const input = Readable.from(["  sk-cp-pasted-key  \n"]);
  assert.equal(await readPastedKey(input), "sk-cp-pasted-key");
});

test("treats a blank line as no key at all", async () => {
  const input = Readable.from(["   \n"]);
  assert.equal(await readPastedKey(input), null);
});
