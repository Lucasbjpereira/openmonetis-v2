export const aiProviders = ["claude", "codex", "antigravity", "minimax", "opencode"] as const;
export type AiProvider = (typeof aiProviders)[number];

/**
 * How each vendor CLI completes its own sign-in. Claude and Antigravity show a page that hands back
 * a code the person pastes; Codex shows a one-time code the person types on the vendor's page;
 * MiniMax takes the key of its M Plan and OpenCode the key of its own service account.
 */
export const aiProviderLoginMethods = ["authorizationCode", "deviceCode", "apiKey"] as const;
export type AiProviderLoginMethod = (typeof aiProviderLoginMethods)[number];

export const aiProviderLoginMethodByProvider = {
  claude: "authorizationCode",
  codex: "deviceCode",
  antigravity: "authorizationCode",
  minimax: "apiKey",
  opencode: "apiKey",
} as const satisfies Record<AiProvider, AiProviderLoginMethod>;

export const aiProviderLoginStatuses = ["pending", "connected", "failed", "expired"] as const;
export type AiProviderLoginStatus = (typeof aiProviderLoginStatuses)[number];

/** `unavailable` means the AI service could not be reached, not that the account is signed out. */
export const aiProviderStatuses = ["connected", "disconnected", "unavailable"] as const;
export type AiProviderStatus = (typeof aiProviderStatuses)[number];

export const aiProviderLoginCodeMaximumLength = 512;

/** Model ids travel to a CLI flag, so they never start with a dash and stay short. */
export const aiProviderModelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
export const aiProviderModelNameMaximumLength = 120;
