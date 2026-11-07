import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { aiProviderLoginMethodByProvider } from "@openmonetis/domain/ai-providers";
import { createCliEnvironment } from "../utils/env";
import { runCommand } from "../utils/process";
import { opencodeBaseConfig, runOpencode } from "./opencode-cli";
import {
  type CommandSource,
  classifyRunFailure,
  commandOf,
  type LoginPrompt,
  type ProviderAdapter,
  type ProviderModel,
} from "./provider";

const statusTimeoutMs = 15_000;
const runTimeoutMs = 180_000;
const chatTimeoutMs = 180_000;

/** Printed by the sign-in helper so the dialog can show the link while the key is still waited for. */
export const opencodeReadyMarker = "OPENCODE_LOGIN_READY";

/** Where the console shows the personal access tokens. */
export const opencodeConsoleUrl = "https://opencode.ai/auth";

const defaultModelId = "opencode-go/minimax-m3.1-flash";

function databasePath(home: string) {
  return path.join(home, "opencode.db");
}

/**
 * The configuration the CLI runs with. The credentials come from the person's own OpenCode
 * account, imported into the database that lives in their home.
 */
export function opencodeConfig() {
  return {
    ...opencodeBaseConfig(),
  };
}

function cliEnvironment(home: string) {
  return createCliEnvironment({
    HOME: home,
    OPENCODE_CONFIG: path.join(home, "opencode.json"),
    OPENCODE_DB: databasePath(home),
    OPENCODE_DISABLE_AUTOUPDATER: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  });
}

/** The models the person's own OpenCode account can use. */
async function readOpencodeModels(command: string, home: string): Promise<ProviderModel[]> {
  const result = await runCommand(command, ["--standalone", "models"], {
    env: cliEnvironment(home),
    timeoutMs: statusTimeoutMs,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("/"))
    .filter((line) => line.startsWith("opencode-go/") || line.startsWith("opencode/"))
    .slice(0, 60)
    .map((line) => {
      const id = line.split("#")[0];
      const name = id.slice(id.indexOf("/") + 1);
      return {
        id,
        name: name.replaceAll("-", " "),
        isDefault: id === defaultModelId,
      };
    });
}

/**
 * OpenCode, run with the person's own OpenCode account. The credentials are the ones the CLI
 * exports, so the person never types a password here.
 */
export function createOpencodeProvider(cli: CommandSource = "opencode"): ProviderAdapter {
  return {
    provider: "opencode",
    loginMethod: aiProviderLoginMethodByProvider.opencode,

    async readAccount(home) {
      const result = await runCommand(commandOf(cli), ["--standalone", "auth", "list"], {
        env: cliEnvironment(home),
        timeoutMs: statusTimeoutMs,
      });
      return result.exitCode === 0 && result.stdout.includes("stored") ? { email: null } : null;
    },

    loginCommand(home) {
      return {
        command: process.execPath,
        args: ["--import", "tsx", loginHelperPath(), home],
        env: { PATH: process.env.PATH ?? "", HOME: home },
      };
    },

    parseLoginPrompt(output): LoginPrompt | null {
      if (!output.includes(opencodeReadyMarker)) return null;
      return { verificationUrl: opencodeConsoleUrl, userCode: null };
    },

    async logout(home) {
      await rm(databasePath(home), { force: true });
    },

    async listModels(home) {
      return readOpencodeModels(commandOf(cli), home);
    },

    async run(home, input) {
      const model = input.model ?? defaultModelId;
      const result = await runOpencode({
        home,
        command: commandOf(cli),
        config: opencodeConfig(),
        model,
        prompt: buildPrompt(input.instructions, input.prompt, input.schema),
        timeoutMs: runTimeoutMs,
        signal: input.signal,
      });
      if (result.status !== "completed")
        return { status: "failed", code: failureCode(result.error) };
      try {
        return {
          status: "completed",
          output: JSON.parse(result.text),
          model: { id: model, name: model },
        };
      } catch {
        return { status: "failed", code: "invalidOutput" };
      }
    },

    async chat(home, input, emit) {
      const model = input.model ?? defaultModelId;
      const result = await runOpencode({
        home,
        command: commandOf(cli),
        config: opencodeConfig(),
        model,
        prompt: input.prompt,
        timeoutMs: chatTimeoutMs,
        signal: input.signal,
        onText: (text) => emit({ type: "delta", text }),
      });
      if (result.status !== "completed")
        return { status: "failed", code: failureCode(result.error) };
      return { status: "completed", text: result.text, model: { id: model, name: model } };
    },
  };
}

function buildPrompt(instructions: string, prompt: string, schema: unknown) {
  return [
    instructions,
    "",
    "Answer only with the JSON object required by this JSON Schema:",
    JSON.stringify(schema),
    "",
    prompt,
  ].join("\n");
}

/** The sign-in helper lives next to this file inside the deployed service. */
function loginHelperPath() {
  return new URL("./opencode-login.ts", import.meta.url).pathname;
}

function failureCode(message: string) {
  if (message === "timedOut") return "timedOut" as const;
  if (message === "canceled") return "canceled" as const;
  if (message === "unsafe") return "runFailed" as const;
  return classifyRunFailure({ aborted: false, timedOut: false, stdout: "", stderr: message });
}

/** Reads the credentials the CLI exported, so the helper can import them. */
export async function readOpencodeCredentials(home: string): Promise<string | null> {
  try {
    const value = (await readFile(path.join(home, "credentials.json"), "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
