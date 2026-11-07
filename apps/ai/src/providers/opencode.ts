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

/** Printed by the sign-in helper so the dialog can show the link while the key is still waited for. */
export const opencodeReadyMarker = "OPENCODE_LOGIN_READY";

/** Where the console shows the service accounts and their keys. */
export const opencodeConsoleUrl = "https://opencode.ai/console/service-accounts";

/** OpenCode's own gateway, which serves the models of the account that owns the key. */
export const opencodeInferenceBaseUrl = "https://opencode.ai/inference";

/** The OpenAI-compatible path of that gateway. */
export const opencodeChatBaseUrl = `${opencodeInferenceBaseUrl}/openai/v1`;

/** The catalog of models the gateway serves. */
export const opencodeModelsUrl = `${opencodeInferenceBaseUrl}/v1/models`;

const keyFileName = "opencode.key";
const providerId = "opencode-console";

/** The model the provider answers with unless the person picks another one. */
const preferredModelId = "minimax-m3";

type ConsoleModel = {
  id: string;
  name?: string;
  limit?: { context?: number; output?: number };
  api?: Record<string, { base_url?: string; sdk?: { aisdk?: string } }>;
};

export type OpencodeConsoleModel = {
  id: string;
  name: string;
  context: number;
  output: number;
};

const catalogLifetimeMs = 10 * 60_000;
let catalogCache: { models: OpencodeConsoleModel[]; expiresAt: number } | null = null;

function keyPath(home: string) {
  return path.join(home, keyFileName);
}

/** The key is kept in the provider's own home, never in the environment of another provider. */
export async function readOpencodeKey(home: string): Promise<string | null> {
  try {
    const key = (await readFile(keyPath(home), "utf8")).trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export async function writeOpencodeKey(home: string, key: string) {
  await writeFile(keyPath(home), `${key.trim()}\n`, { mode: 0o600 });
}

/**
 * The models the gateway serves through the OpenAI-compatible API, which is the protocol the CLI
 * speaks here. The catalog is public, so it costs nothing to read, but it is big: it is kept for a
 * while instead of being downloaded on every call.
 */
export async function readOpencodeCatalog(): Promise<OpencodeConsoleModel[]> {
  const cached = catalogCache;
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  try {
    const response = await fetch(opencodeModelsUrl, {
      signal: AbortSignal.timeout(statusTimeoutMs),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: ConsoleModel[] };
    const models = (body.data ?? [])
      .filter((model) => model.api?.["chat-completions"])
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        context: model.limit?.context ?? 200_000,
        output: model.limit?.output ?? 32_000,
      }));
    catalogCache = { models, expiresAt: Date.now() + catalogLifetimeMs };
    return models;
  } catch {
    return [];
  }
}

/** Even when the catalog could not be read, the model the provider answers with must be there. */
function catalogOrFallback(models: OpencodeConsoleModel[]): OpencodeConsoleModel[] {
  return models.length > 0
    ? models
    : [{ id: preferredModelId, name: preferredModelId, context: 200_000, output: 32_000 }];
}

function defaultModelOf(models: OpencodeConsoleModel[]): string {
  const preferred = models.find((model) => model.id === preferredModelId);
  return preferred?.id ?? models[0]?.id ?? preferredModelId;
}

/**
 * Checks a service account key with a minimal completion, which is the only call that proves the
 * key may both read the catalog and use the plan.
 */
export async function checkOpencodeKey(key: string): Promise<{ valid: boolean; reason: string | null }> {
  const models = await readOpencodeCatalog();
  const model = defaultModelOf(models);
  try {
    const response = await fetch(`${opencodeChatBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(statusTimeoutMs),
    });
    if (response.ok) return { valid: true, reason: null };
    const detail = await response.text().catch(() => "");
    return { valid: false, reason: explain(response.status, detail) };
  } catch (error) {
    return {
      valid: false,
      reason: `O OpenCode não respondeu: ${error instanceof Error ? error.message : "falha de rede"}`,
    };
  }
}

function explain(status: number, detail: string): string {
  if (status === 401) {
    return "O OpenCode recusou a chave. Use a chave de API de service account (oc_sk-...), criada em opencode.ai/console/service-accounts.";
  }
  if (status === 403) {
    return "O OpenCode recusou a chave: a service account não tem permissão para chamar modelos (Models › Request).";
  }
  if (status === 402 || /balance|credit|quota|insufficient|billing|plan/i.test(detail)) {
    return `O OpenCode recusou a chave: ${detail.slice(0, 300)}`;
  }
  return `O OpenCode recusou a chave (HTTP ${status}): ${detail.slice(0, 300)}`;
}

/** The configuration that points the CLI at the OpenCode gateway with the person's own key. */
export function opencodeConfig(models: OpencodeConsoleModel[]) {
  const known = catalogOrFallback(models);
  return {
    ...opencodeBaseConfig(),
    providers: {
      [providerId]: {
        name: "OpenCode",
        package: "@ai-sdk/openai-compatible",
        settings: {
          baseURL: opencodeChatBaseUrl,
          // The key stays in the environment of the command, never in the file on disk.
          apiKey: "{env:OPENCODE_API_KEY}",
        },
        models: Object.fromEntries(
          known.map((model) => [
            model.id,
            {
              modelID: model.id,
              name: model.name,
              limit: { context: model.context, output: model.output },
            },
          ]),
        ),
      },
    },
    model: `${providerId}/${defaultModelOf(known)}`,
  };
}

function toProviderModels(models: OpencodeConsoleModel[]): ProviderModel[] {
  const fallback = defaultModelOf(models);
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    isDefault: model.id === fallback,
  }));
}

/**
 * OpenCode, run with the person's own service account. The key is the one the console shows for
 * a service account, so the models of the account are the ones the gateway serves.
 */
export function createOpencodeProvider(cli: CommandSource = "opencode"): ProviderAdapter {
  return {
    provider: "opencode",
    loginMethod: aiProviderLoginMethodByProvider.opencode,

    async readAccount(home) {
      // The key was checked when it was pasted; checking it again on every listing would spend
      // the plan's quota for nothing.
      const key = await readOpencodeKey(home);
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
      if (!output.includes(opencodeReadyMarker)) return null;
      return { verificationUrl: opencodeConsoleUrl, userCode: null };
    },

    parseLoginFailure,

    async logout(home) {
      await rm(keyPath(home), { force: true });
    },

    async listModels(home) {
      const key = await readOpencodeKey(home);
      if (!key) return [];
      return toProviderModels(await readOpencodeCatalog());
    },

    async run(home, input) {
      const key = await readOpencodeKey(home);
      if (!key) return { status: "failed", code: "providerDisconnected" };
      const models = catalogOrFallback(await readOpencodeCatalog());
      const model = input.model ?? defaultModelOf(models);
      const result = await runOpencode({
        home,
        command: commandOf(cli),
        config: opencodeConfig(models),
        model: `${providerId}/${model}`,
        prompt: buildPrompt(input.instructions, input.prompt, input.schema),
        extraEnv: { OPENCODE_API_KEY: key },
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
      const key = await readOpencodeKey(home);
      if (!key) return { status: "failed", code: "providerDisconnected" };
      const models = catalogOrFallback(await readOpencodeCatalog());
      const model = input.model ?? defaultModelOf(models);
      const result = await runOpencode({
        home,
        command: commandOf(cli),
        config: opencodeConfig(models),
        model: `${providerId}/${model}`,
        prompt: input.prompt,
        extraEnv: { OPENCODE_API_KEY: key },
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
