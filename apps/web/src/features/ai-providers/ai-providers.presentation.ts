import type { AiProvider, AiProviderStatus } from "@openmonetis/domain/ai-providers";
import { formatDateInBrazil } from "@openmonetis/shared/date-time";
import type { AiProviderModel } from "@openmonetis/validators/ai-providers";
import { AiProvidersApiError } from "./ai-providers.api";

export const aiProviderLabels: Record<AiProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  minimax: "MiniMax",
  opencode: "OpenCode",
};

export const aiProviderPlanDescriptions: Record<AiProvider, string> = {
  claude: "Use sua assinatura Claude Pro ou Max.",
  codex: "Use sua assinatura ChatGPT Plus, Pro ou Business.",
  antigravity: "Use sua conta Google com Antigravity.",
  minimax: "Use a chave do seu M Plan.",
  opencode: "Use a chave da sua service account.",
};

/** What the person pastes to connect a provider that takes a key instead of a browser sign-in. */
export const aiProviderCredentialLabels: Record<AiProvider, string> = {
  claude: "código do login",
  codex: "código do login",
  antigravity: "código do login",
  minimax: "chave da API do M Plan",
  opencode: "chave da API da service account",
};

/** Where each key comes from, so nobody pastes the wrong one. */
export const aiProviderApiKeyHints: Partial<Record<AiProvider, string>> = {
  minimax:
    "Cole a chave do M Plan (começa com sk-cp-...). Ela fica guardada no seu próprio espaço no servidor e só é usada para chamar a API do MiniMax.",
  opencode:
    "Cole a chave da service account do OpenCode (começa com oc_sk_...). Ela fica guardada no seu próprio espaço no servidor e só é usada para chamar a API do OpenCode.",
};

export const aiProviderStatusLabels: Record<AiProviderStatus, string> = {
  connected: "Conectado",
  disconnected: "Desconectado",
  unavailable: "Indisponível",
};

export function aiProviderErrorMessage(error: unknown) {
  if (error instanceof AiProvidersApiError) {
    if (error.code === "ai_disabled") return "A IA não está habilitada nesta instalação.";
    if (error.code === "ai_service_unavailable") {
      return "O serviço de IA não respondeu. Tente novamente em instantes.";
    }
    if (error.code === "ai_model_unavailable") {
      return "Este modelo não está disponível na sua assinatura.";
    }
    if (error.code === "ai_provider_not_connected") return "Conecte o assistente primeiro.";
    if (error.code === "ai_login_not_found") return "O login expirou. Comece novamente.";
    if (error.status === 429) return "Muitas tentativas. Aguarde um minuto.";
  }
  return "Não foi possível concluir a ação. Tente novamente.";
}

/** Sentinel for the "plan default" option, since a select value cannot be null. */
export const aiProviderDefaultModelValue = "default";

export function formatAiModelLabel(models: readonly AiProviderModel[], modelId: string | null) {
  if (!modelId) return "Padrão do plano";
  return models.find((model) => model.id === modelId)?.name ?? modelId;
}

/** Brand marks bundled with the web app; Codex uses the OpenAI mark, with a variant per theme. */
export const aiProviderLogos: Record<AiProvider, { light: string; dark: string }> = {
  claude: { light: "/images/ai-providers/claude.svg", dark: "/images/ai-providers/claude.svg" },
  codex: {
    light: "/images/ai-providers/openai-light.svg",
    dark: "/images/ai-providers/openai-dark.svg",
  },
  antigravity: {
    light: "/images/ai-providers/antigravity.png",
    dark: "/images/ai-providers/antigravity.png",
  },
  minimax: { light: "/images/ai-providers/minimax.svg", dark: "/images/ai-providers/minimax.svg" },
  opencode: {
    light: "/images/ai-providers/opencode.svg",
    dark: "/images/ai-providers/opencode.svg",
  },
};

export function formatAiProviderConnectedAt(value: string) {
  return formatDateInBrazil(new Date(value), {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).replaceAll(".", "");
}

/** `75` → `1:15`, for the time left to finish a sign-in. */
export function formatAiLoginTimeLeft(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
