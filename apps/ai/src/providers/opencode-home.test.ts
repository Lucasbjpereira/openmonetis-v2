import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMinimaxProvider } from "./minimax";
import { checkMinimaxKey } from "./minimax";
import { parseLoginFailure } from "./login-failure";
import { createOpencodeProvider, readOpencodeCatalog } from "./opencode";
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

/** Answers every call with the same response, so no test touches the network. */
async function withStubbedFetch(
  answer: (url: string) => { status: number; body: string },
  use: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = answer(url);
    return new Response(body, { status });
  }) as typeof globalThis.fetch;
  try {
    await use();
  } finally {
    globalThis.fetch = original;
  }
}

test("an OpenCode run keeps everything it writes inside the provider's home", async () => {
  await withFakeOpencode(
    '{"type":"text","part":{"text":"ok"}}',
    async ({ home, command, homeFile }) => {
      const result = await runOpencode({
        home,
        command,
        config: {},
        model: "opencode-console/minimax-m3",
        prompt: "oi",
        timeoutMs: 30_000,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.text, "ok");
      assert.equal(await readFile(homeFile, "utf8"), home);
    },
  );
});

test("the sign-in helpers run with the provider's home", () => {
  const home = "/data/homes/a-person/minimax";
  assert.equal(createMinimaxProvider().loginCommand(home).env.HOME, home);
  assert.equal(createOpencodeProvider().loginCommand(home).env.HOME, home);
});

test("the sign-in helpers resolve the TypeScript loader, which the home cannot find", () => {
  const home = "/data/homes/a-person/minimax";
  for (const adapter of [createMinimaxProvider(), createOpencodeProvider()]) {
    const args = adapter.loginCommand(home).args;
    assert.equal(args[0], "--import");
    // A bare "tsx" would be looked up from the provider's home, where the package does not exist.
    assert.match(args[1], /^file:\/\/\/.+\.mjs$/);
    assert.ok(args[2].endsWith("-login.ts"));
    assert.equal(args[3], home);
  }
});

test("the OpenCode provider is connected when its home holds the key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openmonetis-oc-"));
  const home = path.join(directory, "home");
  await mkdir(home, { recursive: true });
  try {
    assert.equal(await createOpencodeProvider().readAccount(home), null);
    await writeFile(path.join(home, "opencode.key"), "oc_sk_teste\n", { mode: 0o600 });
    assert.deepEqual(await createOpencodeProvider().readAccount(home), { email: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the OpenCode provider lists the models the gateway serves", async () => {
  const catalog = {
    data: [
      {
        id: "minimax-m3",
        name: "MiniMax-M3",
        limit: { context: 512000, output: 128000 },
        api: { "chat-completions": { base_url: "https://opencode.ai/inference/openai/v1" } },
      },
      {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        limit: { context: 1000000, output: 128000 },
        api: { messages: { base_url: "https://opencode.ai/inference/anthropic/v1" } },
      },
    ],
  };
  await withStubbedFetch(
    () => ({ status: 200, body: JSON.stringify(catalog) }),
    async () => {
      const models = await readOpencodeCatalog();
      // Only the models served by the OpenAI-compatible API can be called here.
      assert.deepEqual(
        models.map((model) => model.id),
        ["minimax-m3"],
      );
      assert.equal(models[0].context, 512000);
    },
  );
});

test("a MiniMax key is accepted when the plan answers the completion", async () => {
  const asked: string[] = [];
  await withStubbedFetch(
    (url) => {
      asked.push(url);
      if (url.endsWith("/models")) return { status: 401, body: "{}" };
      return { status: 200, body: "{}" };
    },
    async () => {
      const check = await checkMinimaxKey("sk-cp-teste");
      assert.equal(check.valid, true);
      assert.equal(check.reason, null);
      // The catalog does not take a M Plan key, so the call the plan pays for is the one that counts.
      assert.equal(asked.length, 2);
      assert.ok(asked[1].endsWith("/chat/completions"));
    },
  );
});

test("the reason a MiniMax key was refused is reported", async () => {
  await withStubbedFetch(
    () => ({
      status: 401,
      body: JSON.stringify({ error: { message: "login fail: unauthorized" } }),
    }),
    async () => {
      const check = await checkMinimaxKey("sk-cp-invalida");
      assert.equal(check.valid, false);
      assert.match(check.reason ?? "", /recusou a chave/);
    },
  );
});

test("the reason the sign-in failed is read from what the helper printed", () => {
  assert.equal(parseLoginFailure("anything"), null);
  assert.equal(parseLoginFailure("LOGIN_FAILED: a chave foi recusada"), "a chave foi recusada");
});
