import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { aiProviderLoginMethodByProvider } from "@openmonetis/domain/ai-providers";
import { tsxLoaderUrl } from "../utils/tsx";
import { parseLoginFailure } from "./login-failure";
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
export const minimaxConsoleUrl = "https://platform.minimax.io/console/plan";

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

type Probe = { ok: boolean; status: number; detail: string };

/** Calls MiniMax and reports what it answered, without ever logging the key. */
async function probe(url: string, key: string, init?: RequestInit): Promise<Probe> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(statusTimeoutMs),
    });
    const body = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, detail: describeBody(body) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      detail: error instanceof Error ? error.message : "falha de rede",
    };
  }
}

/** MiniMax answers with `{ error: { message } }`; anything else is shown as it came. */
function describeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  } catch {
    // Not a JSON answer: the raw text is the best explanation available.
  }
  return body.trim().slice(0, 300);
}

/** Turns what MiniMax answered into something the person can act on. */
function explain(failure: Probe): string {
  const detail = failure.detail;
  if (failure.status === 401 || /login fail|authorized_error/i.test(detail)) {
    return "O MiniMax recusou a chave. Use a chave do M Plan (sk-cp-...), criada em platform.minimax.io/console/plan, e confira se o plano continua ativo.";
  }
  if (failure.status === 403) {
    return "O MiniMax recusou a chave: este plano não tem permissão para a chave colada.";
  }
  if (/balance|credit|quota|insufficient|expire|subscription|plan/i.test(detail)) {
    return `O MiniMax recusou a chave: ${detail}`;
  }
  if (failure.status === 0) return `O MiniMax não respondeu: ${detail}`;
  return `O MiniMax recusou a chave (HTTP ${failure.status}): ${detail}`;
}

export type MinimaxKeyCheck = { valid: boolean; reason: string | null };

/**
 * Checks a key without keeping the conversation going.
 *
 * The catalog is tried first because it costs nothing, but a M Plan Subscription Key is not
 * accepted there, so the key is also checked with the call the plan actually pays for: a minimal
 * completion. When both refuse it, the answer says why.
 */
export async function checkMinimaxKey(key: string): Promise<MinimaxKeyCheck> {
  const catalog = await probe(`${minimaxBaseUrl}/models`, key);
  if (catalog.ok) return { valid: true, reason: null };
  const completion = await probe(`${minimaxBaseUrl}/chat/completions`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: defaultModelId,
      max_tokens: 64,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  if (completion.ok) return { valid: true, reason: null };
  return { valid: false, reason: explain(completion.status ? completion : catalog) };
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
      // The key was checked when it was pasted; checking it again on every listing would spend
      // the plan's quota for nothing.
      const key = await readMinimaxKey(home);
      return key ? { email: null } : null;
    },

    loginCommand(home) {
      return {
        command: process.execPath,
        args: ["--import", tsxLoaderUrl, loginHelperPath(), home],
        env: { PATH: process.env.PATH ?? "", HOME: home },
      };
    },

    parseLoginPrompt(output): LoginPrompt | null {
      if (!output.includes(minimaxReadyMarker)) return null;
      return { verificationUrl: minimaxConsoleUrl, userCode: null };
    },

    parseLoginFailure,

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
