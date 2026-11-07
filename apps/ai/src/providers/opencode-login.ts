import { mkdir } from "node:fs/promises";
import { readPastedKey } from "../utils/read-line";
import { writeLoginFailure } from "./login-failure";
import { checkOpencodeKey, opencodeReadyMarker, writeOpencodeKey } from "./opencode";

/**
 * The OpenCode sign-in helper. The person pastes the key of a service account; this reads it from
 * the standard input, checks it against the OpenCode gateway and keeps it in the provider's own
 * home. The ready marker is printed first, so the dialog can show the console link while the key
 * is still being waited for.
 */
async function main() {
  const home = process.argv[2];
  if (!home) {
    process.stderr.write("opencode login: missing home\n");
    process.exit(2);
  }

  await mkdir(home, { recursive: true, mode: 0o700 });
  process.stdout.write(`${opencodeReadyMarker}\n`);

  const trimmed = await readPastedKey();
  if (!trimmed) {
    writeLoginFailure("Nenhuma chave foi colada.");
    process.stderr.write("opencode login: empty key\n");
    process.exit(1);
  }

  const check = await checkOpencodeKey(trimmed);
  if (!check.valid) {
    writeLoginFailure(check.reason ?? "O OpenCode recusou a chave.");
    process.stderr.write("opencode login: key refused\n");
    process.exit(1);
  }

  await writeOpencodeKey(home, trimmed);
  process.stdout.write("opencode login: key accepted\n");
  process.exit(0);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeLoginFailure(`Falha ao falar com o OpenCode: ${message}`);
  process.stderr.write(`opencode login: ${message}\n`);
  process.exit(2);
});
