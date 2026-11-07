import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { opencodeReadyMarker } from "./opencode";

/**
 * The OpenCode sign-in helper. The person pastes what `opencode auth export` printed; this imports
 * it into the database of their own home. The ready marker is printed first, so the dialog can
 * show the link while the credentials are still being waited for.
 */
async function main() {
  const home = process.argv[2];
  if (!home) {
    process.stderr.write("opencode login: missing home\n");
    process.exit(2);
  }

  await mkdir(home, { recursive: true, mode: 0o700 });
  process.stdout.write(`${opencodeReadyMarker}\n`);

  const credentials = await readLine();
  const trimmed = credentials?.trim() ?? "";
  if (!trimmed) {
    process.stderr.write("opencode login: empty credentials\n");
    process.exit(1);
  }

  const imported = await importCredentials(home, trimmed);
  if (!imported) {
    process.stderr.write("opencode login: credentials refused\n");
    process.exit(1);
  }

  process.stdout.write("opencode login: credentials accepted\n");
  process.exit(0);
}

/** One line from the standard input, which is where the pasted credentials arrive. */
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

/** Hands the credentials to the CLI, which keeps them in the database of this home. */
function importCredentials(home: string, credentials: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("opencode", ["--standalone", "auth", "import"], {
      env: {
        ...process.env,
        HOME: home,
        OPENCODE_DB: path.join(home, "opencode.db"),
        OPENCODE_CONFIG: path.join(home, "opencode.json"),
      },
      stdio: "pipe",
    });
    child.stdin.end(credentials);
    child.stderr.resume();
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `opencode login: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
});
