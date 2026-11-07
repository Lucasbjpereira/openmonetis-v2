import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { minimaxReadyMarker, validateMinimaxKey, writeMinimaxKey } from "./minimax";

/**
 * The MiniMax sign-in helper. The person pastes an API key; this reads it from the standard input,
 * checks it against MiniMax and keeps it in the provider's own home. The ready marker is printed
 * first, so the dialog can show the console link while the key is still being waited for.
 */
async function main() {
  const home = process.argv[2];
  if (!home) {
    process.stderr.write("minimax login: missing home\n");
    process.exit(2);
  }

  await mkdir(home, { recursive: true, mode: 0o700 });
  process.stdout.write(`${minimaxReadyMarker}\n`);

  const key = await readLine();
  const trimmed = key?.trim() ?? "";
  if (!trimmed) {
    process.stderr.write("minimax login: empty key\n");
    process.exit(1);
  }

  if (!(await validateMinimaxKey(trimmed))) {
    process.stderr.write("minimax login: key refused\n");
    process.exit(1);
  }

  await writeMinimaxKey(home, trimmed);
  process.stdout.write("minimax login: key accepted\n");
  process.exit(0);
}

/** One line from the standard input, which is where the pasted key arrives. */
function readLine(): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = createInterface({ input: process.stdin });
    reader.once("line", (line) => {
      reader.close();
      resolve(line);
    });
    reader.once("close", () => resolve(null));
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `minimax login: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
});
