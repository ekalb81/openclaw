import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
  getToolResultText,
  invalidateMessageCharsCacheEntry,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";

// Keep a conservative input budget to absorb tokenizer variance and provider framing overhead.
const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const DEFAULT_MAX_TOOL_PAYLOAD_CHARS = 24_000;
const DEFAULT_SUMMARY_AFTER_TURNS = 2;
const DEFAULT_MAX_TOOL_MESSAGES_IN_CONTEXT = 8;

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
const CONTEXT_LIMIT_TRUNCATION_SUFFIX = `\n${CONTEXT_LIMIT_TRUNCATION_NOTICE}`;

export const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[compacted: tool output removed to free context]";
export const STALE_TOOL_RESULT_COMPACTION_PREFIX = "[compacted: stale tool output summarized]";

export type ToolResultContextCompactionPolicy = {
  enabled?: boolean;
  maxToolPayloadChars?: number;
  summaryAfterTurns?: number;
  maxToolMessagesInContext?: number;
};

type EffectiveToolResultContextCompactionPolicy = {
  enabled: boolean;
  maxToolPayloadChars: number;
  summaryAfterTurns: number;
  maxToolMessagesInContext: number;
};

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

function shallowCloneObject<T extends object>(value: T): T {
  return { ...value };
}

function cloneContextMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    return shallowCloneObject(message);
  });
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function resolveCompactionPolicy(params: {
  policy: ToolResultContextCompactionPolicy | undefined;
  maxSingleToolResultChars: number;
}): EffectiveToolResultContextCompactionPolicy {
  const maxToolPayloadChars = Math.max(
    512,
    Math.min(
      params.maxSingleToolResultChars,
      normalizePositiveInt(params.policy?.maxToolPayloadChars, DEFAULT_MAX_TOOL_PAYLOAD_CHARS),
    ),
  );
  return {
    enabled: params.policy?.enabled !== false,
    maxToolPayloadChars,
    summaryAfterTurns: normalizeNonNegativeInt(
      params.policy?.summaryAfterTurns,
      DEFAULT_SUMMARY_AFTER_TURNS,
    ),
    maxToolMessagesInContext: normalizePositiveInt(
      params.policy?.maxToolMessagesInContext,
      DEFAULT_MAX_TOOL_MESSAGES_IN_CONTEXT,
    ),
  };
}

function resolveToolName(msg: AgentMessage): string {
  const toolName =
    (msg as { toolName?: unknown }).toolName ??
    (msg as { tool_name?: unknown }).tool_name ??
    (msg as { name?: unknown }).name;
  if (typeof toolName !== "string") {
    return "unknown";
  }
  const trimmed = toolName.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function resolveToolCallRef(msg: AgentMessage): string {
  const toolCallId =
    (msg as { toolCallId?: unknown }).toolCallId ??
    (msg as { tool_call_id?: unknown }).tool_call_id;
  if (typeof toolCallId === "string" && toolCallId.trim().length > 0) {
    return `toolCallId:${toolCallId.trim()}`;
  }
  return "toolResult";
}

function compactPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "[empty]";
  }
  const maxChars = 220;
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const head = normalized.slice(0, 140).trimEnd();
  const tail = normalized.slice(-60).trimStart();
  return `${head} ... ${tail}`;
}

function buildStaleToolResultSummary(params: {
  msg: AgentMessage;
  originalText: string;
  originalChars: number;
  reasons: string[];
  assistantTurnsAfter: number;
  newerToolMessages: number;
}): string {
  return [
    STALE_TOOL_RESULT_COMPACTION_PREFIX,
    `tool=${resolveToolName(params.msg)} ref=${resolveToolCallRef(params.msg)} chars=${params.originalChars}`,
    `reason=${params.reasons.join(",")} turnsAfter=${params.assistantTurnsAfter} newerToolMessages=${params.newerToolMessages}`,
    `preview=${compactPreview(params.originalText)}`,
  ].join("\n");
}

function summarizeStaleToolResultMessage(params: {
  msg: AgentMessage;
  reasons: string[];
  assistantTurnsAfter: number;
  newerToolMessages: number;
}): AgentMessage {
  const rawText = getToolResultText(params.msg);
  if (!rawText || rawText.startsWith(STALE_TOOL_RESULT_COMPACTION_PREFIX)) {
    return params.msg;
  }
  return replaceToolResultText(
    params.msg,
    buildStaleToolResultSummary({
      msg: params.msg,
      originalText: rawText,
      originalChars: rawText.length,
      reasons: params.reasons,
      assistantTurnsAfter: params.assistantTurnsAfter,
      newerToolMessages: params.newerToolMessages,
    }),
  );
}

function truncateTextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 0) {
    return CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  const bodyBudget = Math.max(0, maxChars - CONTEXT_LIMIT_TRUNCATION_SUFFIX.length);
  if (bodyBudget <= 0) {
    return CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  let cutPoint = bodyBudget;
  const newline = text.lastIndexOf("\n", bodyBudget);
  if (newline > bodyBudget * 0.7) {
    cutPoint = newline;
  }

  return text.slice(0, cutPoint) + CONTEXT_LIMIT_TRUNCATION_SUFFIX;
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const replacementContent =
    typeof content === "string" || content === undefined ? text : [{ type: "text", text }];

  const sourceRecord = msg as unknown as Record<string, unknown>;
  const { details: _details, ...rest } = sourceRecord;
  return {
    ...rest,
    content: replacementContent,
  } as AgentMessage;
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) {
    return msg;
  }

  const estimatedChars = estimateMessageCharsCached(msg, cache);
  if (estimatedChars <= maxChars) {
    return msg;
  }

  const rawText = getToolResultText(msg);
  if (!rawText) {
    return replaceToolResultText(msg, CONTEXT_LIMIT_TRUNCATION_NOTICE);
  }

  const truncatedText = truncateTextToBudget(rawText, maxChars);
  return replaceToolResultText(msg, truncatedText);
}

function compactExistingToolResultsInPlace(params: {
  messages: AgentMessage[];
  charsNeeded: number;
  cache: MessageCharEstimateCache;
}): number {
  const { messages, charsNeeded, cache } = params;
  if (charsNeeded <= 0) {
    return 0;
  }

  let reduced = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) {
      continue;
    }

    const before = estimateMessageCharsCached(msg, cache);
    if (before <= PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER.length) {
      continue;
    }

    const compacted = replaceToolResultText(msg, PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    applyMessageMutationInPlace(msg, compacted, cache);
    const after = estimateMessageCharsCached(msg, cache);
    if (after >= before) {
      continue;
    }

    reduced += before - after;
    if (reduced >= charsNeeded) {
      break;
    }
  }

  return reduced;
}

function applyMessageMutationInPlace(
  target: AgentMessage,
  source: AgentMessage,
  cache?: MessageCharEstimateCache,
): void {
  if (target === source) {
    return;
  }

  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) {
      delete targetRecord[key];
    }
  }
  Object.assign(targetRecord, sourceRecord);
  if (cache) {
    invalidateMessageCharsCacheEntry(cache, target);
  }
}

function enforceToolResultContextBudgetInPlace(params: {
  messages: AgentMessage[];
  contextBudgetChars: number;
  maxSingleToolResultChars: number;
  policy?: ToolResultContextCompactionPolicy;
}): void {
  const { messages, contextBudgetChars, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();
  const policy = resolveCompactionPolicy({
    policy: params.policy,
    maxSingleToolResultChars,
  });

  // Ensure each tool result has an upper bound before considering total context usage.
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    applyMessageMutationInPlace(message, truncated, estimateCache);
  }

  if (policy.enabled) {
    let assistantTurnsAfter = 0;
    let newerToolMessages = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (isToolResultMessage(message)) {
        const rawText = getToolResultText(message);
        const reasons: string[] = [];
        if (rawText.length > policy.maxToolPayloadChars) {
          reasons.push("payload_limit");
        }
        if (assistantTurnsAfter >= policy.summaryAfterTurns) {
          reasons.push("stale_turns");
        }
        if (newerToolMessages >= policy.maxToolMessagesInContext) {
          reasons.push("max_tool_messages");
        }
        if (reasons.length > 0) {
          const summarized = summarizeStaleToolResultMessage({
            msg: message,
            reasons,
            assistantTurnsAfter,
            newerToolMessages,
          });
          applyMessageMutationInPlace(message, summarized, estimateCache);
        }
        newerToolMessages += 1;
      }

      if ((message as { role?: unknown }).role === "assistant") {
        assistantTurnsAfter += 1;
      }
    }
  }

  let currentChars = estimateContextChars(messages, estimateCache);
  if (currentChars <= contextBudgetChars) {
    return;
  }

  // Compact oldest tool outputs first until the context is back under budget.
  compactExistingToolResultsInPlace({
    messages,
    charsNeeded: currentChars - contextBudgetChars,
    cache: estimateCache,
  });
}

export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
  policy?: ToolResultContextCompactionPolicy;
}): () => void {
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const contextBudgetChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_INPUT_HEADROOM_RATIO),
  );
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(
      contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE,
    ),
  );

  // Agent.transformContext is private in pi-coding-agent, so access it via a
  // narrow runtime view to keep callsites type-safe while preserving behavior.
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    const contextMessages = cloneContextMessages(sourceMessages);
    enforceToolResultContextBudgetInPlace({
      messages: contextMessages,
      contextBudgetChars,
      maxSingleToolResultChars,
      policy: params.policy,
    });

    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
