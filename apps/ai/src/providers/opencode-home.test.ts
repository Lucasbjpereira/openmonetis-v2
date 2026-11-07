import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMinimaxProvider } from "./minimax";
import { createOpencodeProvider } from "./opencode";
import { runOpencode } from "./opencode-cli";

type FakeOpencode = {
  home: string;
  command: string;
  homeFile: string;
};

/**
 * The service runs with a read-only root filesystem, so the CLI may only write inside the
 * provider's own home, which is a writable volume. The fake CLI records the HOME it received.
 */
async function withFakeOpencode(output: string, use: (fake: FakeOpencode) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openmonetis-opencode-"));
  const home = path.join(directory, "home");
  const homeFile = path.join(directory, "home.txt");
  const command = path.join(directory, "opencode");
  await mkdir(home, { recursive: true });
  await writeFile(
    command,
    [
      "#!/usr/bin/env node",
      `require("node:fs").writeFileSync(${JSON.stringify(homeFile)}, String(process.env.HOME ?? ""));`,
      `console.log(${JSON.stringify(output)});`,
    ].join("\n"),
  );
  await chmod(command, 0o755);
  try {
    await use({ home, command, homeFile });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("an OpenCode run keeps everything it writes inside the provider's home", async () => {
  await withFakeOpencode('{"type":"text","part":{"text":"ok"}}', async ({ home, command, homeFile }) => {
    const result = await runOpencode({
      home,
      command,
      config: {},
      model: "minimax/MiniMax-M3.1-Flash",
      prompt: "oi",
      timeoutMs: 30_000,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, "ok");
    assert.equal(await readFile(homeFile, "utf8"), home);
  });
});

test("the OpenCode provider reads the account from the provider's home", async () => {
  await withFakeOpencode("credential stored", async ({ home, command, homeFile }) => {
    const account = await createOpencodeProvider(command).readAccount(home);
    assert.deepEqual(account, { email: null });
    assert.equal(await readFile(homeFile, "utf8"), home);
  });
});

test("the OpenCode provider lists the models from the provider's home", async () => {
  await withFakeOpencode("opencode-go/minimax-m3.1-flash", async ({ home, command, homeFile }) => {
    const models = await createOpencodeProvider(command).listModels(home);
    assert.deepEqual(
      models.map((model) => model.id),
      ["opencode-go/minimax-m3.1-flash"],
    );
    assert.equal(await readFile(homeFile, "utf8"), home);
  });
});

test("the sign-in helpers run with the provider's home", () => {
  const home = "/data/homes/a-person/minimax";
  assert.equal(createMinimaxProvider().loginCommand(home).env.HOME, home);
  assert.equal(createOpencodeProvider().loginCommand(home).env.HOME, home);
});
