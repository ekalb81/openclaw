import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/config.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
} from "./pi-embedded-runner/tool-result-char-estimator.js";

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;
export const PROMPT_BUDGET_DEFAULT_CHARS_PER_TOKEN = CHARS_PER_TOKEN_ESTIMATE;
export const PROMPT_BUDGET_DEFAULT_IMAGE_TOKENS = 1_200;
export const PROMPT_BUDGET_DEFAULT_SOFT_LIMIT_RATIO = 0.7;
export const PROMPT_BUDGET_DEFAULT_HARD_LIMIT_RATIO = 0.85;
export const PROMPT_BUDGET_DEFAULT_PROFILE = "balanced";

export type PromptBudgetSoftAction = "warn" | "trim" | "summarize";
export type PromptBudgetHardAction = "trim" | "summarize" | "block";

export type PromptBudgetProfileConfig = {
  charsPerToken?: number;
  imageTokens?: number;
  softLimitRatio?: number;
  hardLimitRatio?: number;
  softAction?: PromptBudgetSoftAction;
  hardAction?: PromptBudgetHardAction;
};

export type PromptBudgetConfig = {
  enabled?: boolean;
  profile?: string;
  profiles?: Record<string, PromptBudgetProfileConfig>;
} & PromptBudgetProfileConfig;

export type EffectivePromptBudgetSettings = {
  enabled: boolean;
  charsPerToken: number;
  imageTokens: number;
  softLimitRatio: number;
  hardLimitRatio: number;
  softAction: PromptBudgetSoftAction;
  hardAction: PromptBudgetHardAction;
  profile?: string;
};

export type PromptBudgetThresholds = {
  contextWindowTokens: number;
  softLimitTokens: number;
  hardLimitTokens: number;
};

export type PromptInputFootprint = {
  estimatedTokens: number;
  textTokens: number;
  historyChars: number;
  promptChars: number;
  systemChars: number;
  textChars: number;
  imageCount: number;
  imageTokens: number;
  charsPerToken: number;
};

export type PromptBudgetPreflightEvent = {
  phase: "soft" | "hard";
  action: PromptBudgetSoftAction | PromptBudgetHardAction;
  beforeTokens: number;
  afterTokens: number;
  droppedMessages?: number;
  note?: string;
};

export type PromptBudgetPreflightResult = {
  settings: EffectivePromptBudgetSettings;
  limits: PromptBudgetThresholds;
  initial: PromptInputFootprint;
  final: PromptInputFootprint;
  messages: AgentMessage[];
  changed: boolean;
  blocked: boolean;
  events: PromptBudgetPreflightEvent[];
};

export type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

export type ContextWindowInfo = {
  tokens: number;
  source: ContextWindowSource;
};

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function clampRatio(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

function resolveModelPromptBudgetOverride(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
}): PromptBudgetConfig | undefined {
  const models = params.cfg?.agents?.defaults?.models as
    | Record<string, { promptBudget?: PromptBudgetConfig }>
    | undefined;
  if (!models) {
    return undefined;
  }

  const exact = models[`${params.provider}/${params.modelId}`];
  if (exact?.promptBudget) {
    return exact.promptBudget;
  }

  const loweredKey = `${params.provider.toLowerCase()}/${params.modelId.toLowerCase()}`;
  if (loweredKey !== `${params.provider}/${params.modelId}`) {
    const lowered = models[loweredKey];
    if (lowered?.promptBudget) {
      return lowered.promptBudget;
    }
  }

  return undefined;
}

const PROMPT_BUDGET_BUILTIN_PROFILES: Record<string, PromptBudgetProfileConfig> = {
  conservative: {
    softLimitRatio: 0.6,
    hardLimitRatio: 0.75,
    softAction: "trim",
    hardAction: "block",
  },
  balanced: {
    softLimitRatio: PROMPT_BUDGET_DEFAULT_SOFT_LIMIT_RATIO,
    hardLimitRatio: PROMPT_BUDGET_DEFAULT_HARD_LIMIT_RATIO,
    softAction: "trim",
    hardAction: "block",
  },
  throughput: {
    softLimitRatio: 0.78,
    hardLimitRatio: 0.92,
    softAction: "warn",
    hardAction: "trim",
  },
};

function sanitizePromptBudgetProfileName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripPromptBudgetMeta(
  value: PromptBudgetConfig | undefined,
): PromptBudgetProfileConfig | undefined {
  if (!value) {
    return undefined;
  }
  const { enabled: _enabled, profile: _profile, profiles: _profiles, ...rest } = value;
  return rest;
}

function resolvePromptBudgetProfileDefaults(params: {
  profile: string;
  globalBudget?: PromptBudgetConfig;
}): PromptBudgetProfileConfig {
  const normalizedProfile = params.profile.toLowerCase();
  const builtin = PROMPT_BUDGET_BUILTIN_PROFILES[normalizedProfile];
  const configured =
    params.globalBudget?.profiles &&
    typeof params.globalBudget.profiles === "object" &&
    !Array.isArray(params.globalBudget.profiles)
      ? (params.globalBudget.profiles[params.profile] ??
        params.globalBudget.profiles[normalizedProfile])
      : undefined;
  return Object.assign({}, builtin, configured);
}

export function resolvePromptBudgetSettings(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
}): EffectivePromptBudgetSettings {
  const globalBudget = params.cfg?.agents?.defaults?.promptBudget as PromptBudgetConfig | undefined;
  const modelBudget = resolveModelPromptBudgetOverride(params);
  const enabledOverride = modelBudget?.enabled ?? globalBudget?.enabled;
  const selectedProfile =
    sanitizePromptBudgetProfileName(modelBudget?.profile) ??
    sanitizePromptBudgetProfileName(globalBudget?.profile) ??
    PROMPT_BUDGET_DEFAULT_PROFILE;
  const profileDefaults = resolvePromptBudgetProfileDefaults({
    profile: selectedProfile,
    globalBudget,
  });
  const merged = Object.assign(
    {},
    profileDefaults,
    stripPromptBudgetMeta(globalBudget),
    stripPromptBudgetMeta(modelBudget),
  );

  const softLimitRatio = clampRatio(merged.softLimitRatio, PROMPT_BUDGET_DEFAULT_SOFT_LIMIT_RATIO);
  const hardLimitRatioRaw = clampRatio(
    merged.hardLimitRatio,
    PROMPT_BUDGET_DEFAULT_HARD_LIMIT_RATIO,
  );
  const hardLimitRatio = Math.max(
    softLimitRatio,
    Math.min(1, Math.max(hardLimitRatioRaw, softLimitRatio + 0.05)),
  );

  return {
    enabled: enabledOverride !== false,
    profile: selectedProfile,
    charsPerToken: normalizePositiveNumber(
      merged.charsPerToken,
      PROMPT_BUDGET_DEFAULT_CHARS_PER_TOKEN,
    ),
    imageTokens: normalizeNonNegativeInt(merged.imageTokens, PROMPT_BUDGET_DEFAULT_IMAGE_TOKENS),
    softLimitRatio,
    hardLimitRatio,
    softAction: merged.softAction ?? "trim",
    hardAction: merged.hardAction ?? "block",
  };
}

export function resolvePromptBudgetThresholds(params: {
  contextWindowTokens: number;
  settings: Pick<EffectivePromptBudgetSettings, "softLimitRatio" | "hardLimitRatio">;
}): PromptBudgetThresholds {
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const softLimitTokens = Math.max(
    1,
    Math.floor(contextWindowTokens * params.settings.softLimitRatio),
  );
  const hardLimitTokens = Math.max(
    softLimitTokens,
    Math.floor(contextWindowTokens * params.settings.hardLimitRatio),
  );
  return {
    contextWindowTokens,
    softLimitTokens,
    hardLimitTokens,
  };
}

export function estimatePromptInputFootprint(params: {
  messages: AgentMessage[];
  prompt: string;
  systemPrompt?: string;
  imagesCount?: number;
  charsPerToken: number;
  imageTokens: number;
}): PromptInputFootprint {
  const cache = createMessageCharEstimateCache();
  const historyChars = estimateContextChars(params.messages, cache);
  const promptChars = params.prompt.length;
  const systemChars = typeof params.systemPrompt === "string" ? params.systemPrompt.length : 0;
  const textChars = historyChars + promptChars + systemChars;
  const textTokens = Math.ceil(
    textChars / normalizePositiveNumber(params.charsPerToken, CHARS_PER_TOKEN_ESTIMATE),
  );
  const imageCount = Math.max(0, Math.floor(params.imagesCount ?? 0));
  const imageTokens = imageCount * Math.max(0, Math.floor(params.imageTokens));
  return {
    estimatedTokens: textTokens + imageTokens,
    textTokens,
    historyChars,
    promptChars,
    systemChars,
    textChars,
    imageCount,
    imageTokens,
    charsPerToken: params.charsPerToken,
  };
}

export function trimMessagesToPromptBudget(params: {
  messages: AgentMessage[];
  maxInputTokens: number;
  promptChars: number;
  systemChars: number;
  imageTokens: number;
  charsPerToken: number;
}): {
  messages: AgentMessage[];
  droppedMessages: number;
} {
  const maxInputTokens = Math.max(1, Math.floor(params.maxInputTokens));
  if (params.messages.length === 0) {
    return { messages: params.messages, droppedMessages: 0 };
  }

  const maxTextTokens = Math.max(0, maxInputTokens - Math.max(0, Math.floor(params.imageTokens)));
  const maxTextChars = Math.max(0, Math.floor(maxTextTokens * params.charsPerToken));
  const promptOverheadChars = Math.max(0, params.promptChars + params.systemChars);
  const historyBudgetChars = Math.max(0, maxTextChars - promptOverheadChars);

  const cache = createMessageCharEstimateCache();
  let keptChars = 0;
  let startIndex = params.messages.length;
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const messageChars = estimateMessageCharsCached(params.messages[i], cache);
    if (startIndex === params.messages.length) {
      // Always keep the most recent message so role ordering does not collapse to empty history.
      keptChars += messageChars;
      startIndex = i;
      continue;
    }
    if (keptChars + messageChars > historyBudgetChars) {
      break;
    }
    keptChars += messageChars;
    startIndex = i;
  }

  const nextMessages =
    startIndex < params.messages.length
      ? params.messages.slice(startIndex)
      : [params.messages[params.messages.length - 1]];
  return {
    messages: nextMessages,
    droppedMessages: Math.max(0, params.messages.length - nextMessages.length),
  };
}

export function runPromptBudgetPreflight(params: {
  messages: AgentMessage[];
  prompt: string;
  systemPrompt?: string;
  imagesCount?: number;
  contextWindowTokens: number;
  settings: EffectivePromptBudgetSettings;
}): PromptBudgetPreflightResult {
  const settings = params.settings;
  const limits = resolvePromptBudgetThresholds({
    contextWindowTokens: params.contextWindowTokens,
    settings,
  });
  const estimateForMessages = (messages: AgentMessage[]) =>
    estimatePromptInputFootprint({
      messages,
      prompt: params.prompt,
      systemPrompt: params.systemPrompt,
      imagesCount: params.imagesCount,
      charsPerToken: settings.charsPerToken,
      imageTokens: settings.imageTokens,
    });

  const initial = estimateForMessages(params.messages);
  if (!settings.enabled) {
    return {
      settings,
      limits,
      initial,
      final: initial,
      messages: params.messages,
      changed: false,
      blocked: false,
      events: [],
    };
  }

  const events: PromptBudgetPreflightEvent[] = [];
  let workingMessages = params.messages;
  let footprint = initial;

  if (footprint.estimatedTokens > limits.softLimitTokens) {
    if (settings.softAction === "warn") {
      events.push({
        phase: "soft",
        action: "warn",
        beforeTokens: footprint.estimatedTokens,
        afterTokens: footprint.estimatedTokens,
      });
    } else {
      const trimResult = trimMessagesToPromptBudget({
        messages: workingMessages,
        maxInputTokens: limits.softLimitTokens,
        promptChars: footprint.promptChars,
        systemChars: footprint.systemChars,
        imageTokens: footprint.imageTokens,
        charsPerToken: settings.charsPerToken,
      });
      if (trimResult.droppedMessages > 0) {
        workingMessages = trimResult.messages;
      }
      const nextFootprint = estimateForMessages(workingMessages);
      events.push({
        phase: "soft",
        action: settings.softAction,
        beforeTokens: footprint.estimatedTokens,
        afterTokens: nextFootprint.estimatedTokens,
        droppedMessages: trimResult.droppedMessages,
        note:
          settings.softAction === "summarize"
            ? "summarize currently uses trim behavior"
            : undefined,
      });
      footprint = nextFootprint;
    }
  }

  let blocked = false;
  if (footprint.estimatedTokens > limits.hardLimitTokens) {
    if (settings.hardAction === "block") {
      events.push({
        phase: "hard",
        action: "block",
        beforeTokens: footprint.estimatedTokens,
        afterTokens: footprint.estimatedTokens,
      });
      blocked = true;
    } else {
      const trimResult = trimMessagesToPromptBudget({
        messages: workingMessages,
        maxInputTokens: limits.hardLimitTokens,
        promptChars: footprint.promptChars,
        systemChars: footprint.systemChars,
        imageTokens: footprint.imageTokens,
        charsPerToken: settings.charsPerToken,
      });
      if (trimResult.droppedMessages > 0) {
        workingMessages = trimResult.messages;
      }
      const nextFootprint = estimateForMessages(workingMessages);
      events.push({
        phase: "hard",
        action: settings.hardAction,
        beforeTokens: footprint.estimatedTokens,
        afterTokens: nextFootprint.estimatedTokens,
        droppedMessages: trimResult.droppedMessages,
        note:
          settings.hardAction === "summarize"
            ? "summarize currently uses trim behavior"
            : undefined,
      });
      footprint = nextFootprint;
      if (footprint.estimatedTokens > limits.hardLimitTokens) {
        events.push({
          phase: "hard",
          action: "block",
          beforeTokens: footprint.estimatedTokens,
          afterTokens: footprint.estimatedTokens,
          note: "still over hard limit after trim/summarize",
        });
        blocked = true;
      }
    }
  }

  return {
    settings,
    limits,
    initial,
    final: footprint,
    messages: workingMessages,
    changed: workingMessages !== params.messages,
    blocked,
    events,
  };
}

export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  const fromModelsConfig = (() => {
    const providers = params.cfg?.models?.providers as
      | Record<string, { models?: Array<{ id?: string; contextWindow?: number }> }>
      | undefined;
    const providerEntry = providers?.[params.provider];
    const models = Array.isArray(providerEntry?.models) ? providerEntry.models : [];
    const match = models.find((m) => m?.id === params.modelId);
    return normalizePositiveInt(match?.contextWindow);
  })();
  const fromModel = normalizePositiveInt(params.modelContextWindow);
  const baseInfo = fromModelsConfig
    ? { tokens: fromModelsConfig, source: "modelsConfig" as const }
    : fromModel
      ? { tokens: fromModel, source: "model" as const }
      : { tokens: Math.floor(params.defaultTokens), source: "default" as const };

  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "agentContextTokens" };
  }

  return baseInfo;
}

export type ContextWindowGuardResult = ContextWindowInfo & {
  shouldWarn: boolean;
  shouldBlock: boolean;
};

export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(
    1,
    Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS),
  );
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
  const tokens = Math.max(0, Math.floor(params.info.tokens));
  return {
    ...params.info,
    tokens,
    shouldWarn: tokens > 0 && tokens < warnBelow,
    shouldBlock: tokens > 0 && tokens < hardMin,
  };
}
