import { mkdir } from "node:fs/promises";
import { readPastedKey } from "../utils/read-line";
import { writeLoginFailure } from "./login-failure";
import { checkMinimaxKey, minimaxReadyMarker, writeMinimaxKey } from "./minimax";

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

  const trimmed = await readPastedKey();
  if (!trimmed) {
    writeLoginFailure("Nenhuma chave foi colada.");
    process.stderr.write("minimax login: empty key\n");
    process.exit(1);
  }

  const check = await checkMinimaxKey(trimmed);
  if (!check.valid) {
    writeLoginFailure(check.reason ?? "O MiniMax recusou a chave.");
    process.stderr.write("minimax login: key refused\n");
    process.exit(1);
  }

  await writeMinimaxKey(home, trimmed);
  process.stdout.write("minimax login: key accepted\n");
  process.exit(0);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeLoginFailure(`Falha ao falar com o MiniMax: ${message}`);
  process.stderr.write(`minimax login: ${message}\n`);
  process.exit(2);
});
