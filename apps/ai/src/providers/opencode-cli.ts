import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCliEnvironment } from "../utils/env";
import { runCommand } from "../utils/process";

export const opencodeConfigFileName = "opencode.json";
export const opencodeDatabaseFileName = "opencode.db";

/** The agent the service runs: it may not read, write, run or fetch anything. */
export const opencodeAgentName = "openmonetis";

/**
 * The events the CLI sends while it answers. Anything else means the agent reached for a tool, and
 * the answer must not be trusted.
 */
const safeEventTypes = new Set([
  "step_start",
  "step_finish",
  "text",
  "reasoning",
  "retry",
  "error",
  "session",
  "session.idle",
  "message.updated",
  "message.part.updated",
]);

export type OpencodeEvent = {
  type?: string;
  part?: { type?: string; text?: string; message?: string; tool?: string };
  error?: { type?: string; message?: string; name?: string };
};

export function parseOpencodeEvent(line: string): OpencodeEvent | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? (value as OpencodeEvent) : null;
  } catch {
    return null;
  }
}

export type OpencodeRunOptions = {
  /** The provider's own home: the config and the database live there, never shared. */
  home: string;
  command: string;
  /** The configuration written to the home before the run. */
  config: Record<string, unknown>;
  model: string;
  prompt: string;
  extraEnv?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
};

export type OpencodeRunResult = {
  status: "completed" | "failed";
  text: string;
  error: string;
  /** The agent tried to use a tool, so the answer is discarded. */
  unsafe: boolean;
};

/**
 * Runs the OpenCode CLI once and reads its answer from the events it streams. The CLI is always
 * started on its own: the background service would answer with the configuration of whoever
 * started it, not with the one written for this provider.
 */
export async function runOpencode(options: OpencodeRunOptions): Promise<OpencodeRunResult> {
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const configPath = path.join(options.home, opencodeConfigFileName);
  const databasePath = path.join(options.home, opencodeDatabaseFileName);
  await writeFile(configPath, `${JSON.stringify(options.config, null, 2)}\n`, { mode: 0o600 });

  let text = "";
  let error = "";
  let unsafe = false;

  const result = await runCommand(
    options.command,
    [
      "--standalone",
      "run",
      "--agent",
      opencodeAgentName,
      "--model",
      options.model,
      "--format",
      "json",
    ],
    {
      cwd: options.home,
      env: createCliEnvironment({
        // The service runs with a read-only root filesystem, so the CLI has to keep its data
        // (log, cache, state) inside the provider's own home, which is a writable volume.
        HOME: options.home,
        OPENCODE_CONFIG: configPath,
        OPENCODE_DB: databasePath,
        OPENCODE_DISABLE_AUTOUPDATER: "1",
        OPENCODE_DISABLE_FILEWATCHER: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        ...options.extraEnv,
      }),
      input: options.prompt,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onStdoutLine: (line) => {
        const event = parseOpencodeEvent(line);
        if (!event) return;
        if (event.type && !safeEventTypes.has(event.type)) {
          unsafe = true;
          return;
        }
        if (event.type === "text" && typeof event.part?.text === "string") {
          text += event.part.text;
          options.onText?.(event.part.text);
          return;
        }
        if (event.type === "reasoning" && typeof event.part?.text === "string") {
          options.onReasoning?.(event.part.text);
          return;
        }
        if (event.type === "error") {
          error = event.error?.message ?? error;
        }
      },
    },
  );

  if (unsafe) return { status: "failed", text, error: "unsafe", unsafe: true };
  if (result.timedOut) return { status: "failed", text, error: "timedOut", unsafe: false };
  if (result.aborted) return { status: "failed", text, error: "canceled", unsafe: false };
  if (error) return { status: "failed", text, error, unsafe: false };
  if (result.exitCode !== 0) {
    return {
      status: "failed",
      text,
      error: result.stderr.trim() || `exit ${result.exitCode}`,
      unsafe: false,
    };
  }
  return { status: "completed", text, error: "", unsafe: false };
}

/**
 * The configuration both providers share: no tool may be used, the CLI never updates itself and
 * no session is ever shared.
 */
export function opencodeBaseConfig() {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    agents: {
      [opencodeAgentName]: {
        mode: "primary",
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          { action: "skill", resource: "*", effect: "deny" },
          { action: "question", resource: "*", effect: "deny" },
          { action: "task", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
        ],
      },
    },
  };
}
