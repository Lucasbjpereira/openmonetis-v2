import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { aiProviderLoginMethodByProvider } from "@openmonetis/domain/ai-providers";
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

/** MiniMax's OpenAI-compatible endpoint. */
export const minimaxBaseUrl = "https://api.minimax.io/v1";

/** Where the console shows the keys a person can copy. */
export const minimaxConsoleUrl = "https://platform.minimax.io/console/api-key";

/** Printed by the sign-in helper so the dialog can show the link while the key is still waited for. */
export const minimaxReadyMarker = "MINIMAX_LOGIN_READY";

const keyFileName = "minimax.key";
const providerId = "minimax";

/** The models MiniMax serves on the OpenAI-compatible endpoint. */
export const minimaxModels: ProviderModel[] = [
  { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash", isDefault: true },
  { id: "MiniMax-M3", name: "MiniMax M3", isDefault: false },
];

const defaultModelId = "MiniMax-M3.1-Flash";

function keyPath(home: string) {
  return path.join(home, keyFileName);
}

/** The key is kept in the provider's own home, never in the environment of another provider. */
export async function readMinimaxKey(home: string): Promise<string | null> {
  try {
    const key = (await readFile(keyPath(home), "utf8")).trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export async function writeMinimaxKey(home: string, key: string) {
  await writeFile(keyPath(home), `${key.trim()}\n`, { mode: 0o600 });
}

/**
 * Checks a key against MiniMax without spending a generation. A key that is refused is reported
 * as such, so the person is told the key is wrong instead of failing on the first diagnosis.
 */
export async function validateMinimaxKey(key: string): Promise<boolean> {
  try {
    const response = await fetch(`${minimaxBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(statusTimeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The configuration that points the CLI at MiniMax with the person's own key. */
export function minimaxConfig() {
  return {
    ...opencodeBaseConfig(),
    providers: {
      [providerId]: {
        name: "MiniMax",
        package: "@ai-sdk/openai-compatible",
        settings: {
          baseURL: minimaxBaseUrl,
          // The key stays in the environment of the command, never in the file on disk.
          apiKey: "{env:MINIMAX_API_KEY}",
        },
        models: Object.fromEntries(
          minimaxModels.map((model) => [model.id, { modelID: model.id, name: model.name }]),
        ),
      },
    },
    model: `${providerId}/${defaultModelId}`,
  };
}

/**
 * MiniMax, run through the OpenCode CLI against MiniMax's OpenAI-compatible endpoint. The CLI is
 * the harness that already streams the answer and keeps the tools away from the data; the person
 * brings their own MiniMax key, so no other account is involved.
 */
export function createMinimaxProvider(cli: CommandSource = "opencode"): ProviderAdapter {
  return {
    provider: "minimax",
    loginMethod: aiProviderLoginMethodByProvider.minimax,

    async readAccount(home) {
      const key = await readMinimaxKey(home);
      if (!key) return null;
      if (!(await validateMinimaxKey(key))) return null;
      return { email: null };
    },

    loginCommand(home) {
      return {
        command: process.execPath,
        args: ["--import", "tsx", loginHelperPath(), home],
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
      };
    },

    parseLoginPrompt(output): LoginPrompt | null {
      if (!output.includes(minimaxReadyMarker)) return null;
      return { verificationUrl: minimaxConsoleUrl, userCode: null };
    },

    async logout(home) {
      await rm(keyPath(home), { force: true });
    },

    async listModels(home) {
      const key = await readMinimaxKey(home);
      if (!key) return [];
      return minimaxModels;
    },

    async run(home, input) {
      const key = await readMinimaxKey(home);
      if (!key) return { status: "failed", code: "providerDisconnected" };
      const model = input.model ?? defaultModelId;
      const result = await runOpencode({
        home,
        command: commandOf(cli),
        config: minimaxConfig(),
        model: `${providerId}/${model}`,
        prompt: buildPrompt(input.instructions, input.prompt, input.schema),
        extraEnv: { MINIMAX_API_KEY: key },
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
      const key = await readMinimaxKey(home);
      if (!key) return { status: "failed", code: "providerDisconnected" };
      const model = input.model ?? defaultModelId;
      const result = await runOpencode({
        home,
        command: commandOf(cli),
        config: minimaxConfig(),
        model: `${providerId}/${model}`,
        prompt: input.prompt,
        extraEnv: { MINIMAX_API_KEY: key },
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

/**
 * The answer must be the JSON object the schema asks for, so the schema travels with the request:
 * the CLI has no flag that forces a shape.
 */
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
  return new URL("./minimax-login.ts", import.meta.url).pathname;
}

function failureCode(message: string) {
  if (message === "timedOut") return "timedOut" as const;
  if (message === "canceled") return "canceled" as const;
  if (message === "unsafe") return "runFailed" as const;
  return classifyRunFailure({ aborted: false, timedOut: false, stdout: "", stderr: message });
}
