import { extractText } from "../chat/message-extract.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const MAIN_SESSION_ALIAS = "agent:main:main";
const DEFAULT_CHAT_RUN_WATCHDOG_MS = 60_000;
const MIN_CHAT_RUN_WATCHDOG_MS = 5_000;
const MAX_CHAT_RUN_WATCHDOG_MS = 15 * 60_000;

function isSilentReplyStream(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text);
}
/** Client-side defense-in-depth: detect assistant messages whose text is purely NO_REPLY. */
function isAssistantSilentReply(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  if (role !== "assistant") {
    return false;
  }
  // entry.text takes precedence — matches gateway extractAssistantTextForSilentCheck
  if (typeof entry.text === "string") {
    return isSilentReplyStream(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && isSilentReplyStream(text);
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunWatchdogTimer?: ReturnType<typeof setTimeout> | null;
  chatRunWatchdogLastActivityAtMs?: number | null;
  chatRunWatchdogRecoveryInFlight?: boolean;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

function normalizeMainSessionAlias(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return normalized === MAIN_SESSION_ALIAS ? "main" : normalized;
}

function sessionKeysMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return normalizeMainSessionAlias(left) === normalizeMainSessionAlias(right);
}

function cancelRunWatchdogTimer(state: ChatState) {
  const timer = state.chatRunWatchdogTimer ?? null;
  if (timer !== null) {
    clearTimeout(timer);
  }
  state.chatRunWatchdogTimer = null;
}

function clearRunWatchdog(state: ChatState) {
  cancelRunWatchdogTimer(state);
  state.chatRunWatchdogLastActivityAtMs = null;
}

function resolveRunWatchdogSettings(state: ChatState): { enabled: boolean; timeoutMs: number } {
  const settings = (state as unknown as { settings?: Record<string, unknown> }).settings ?? {};
  const enabled =
    typeof settings.chatRunWatchdogEnabled === "boolean" ? settings.chatRunWatchdogEnabled : true;
  const timeoutRaw =
    typeof settings.chatRunWatchdogMs === "number" && Number.isFinite(settings.chatRunWatchdogMs)
      ? settings.chatRunWatchdogMs
      : DEFAULT_CHAT_RUN_WATCHDOG_MS;
  const timeoutMs = Math.min(
    MAX_CHAT_RUN_WATCHDOG_MS,
    Math.max(MIN_CHAT_RUN_WATCHDOG_MS, timeoutRaw),
  );
  return { enabled, timeoutMs };
}

async function recoverFromRunWatchdog(state: ChatState) {
  if (state.chatRunWatchdogRecoveryInFlight) {
    return;
  }
  state.chatRunWatchdogRecoveryInFlight = true;
  try {
    await loadChatHistory(state);
  } catch {
    // best-effort recovery
  } finally {
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    clearRunWatchdog(state);
    state.chatRunWatchdogRecoveryInFlight = false;
  }
}

function scheduleRunWatchdog(state: ChatState) {
  cancelRunWatchdogTimer(state);
  if (!state.chatRunId) {
    return;
  }
  const { enabled, timeoutMs } = resolveRunWatchdogSettings(state);
  if (!enabled) {
    return;
  }
  const runId = state.chatRunId;
  const now = Date.now();
  if (state.chatRunWatchdogLastActivityAtMs == null) {
    state.chatRunWatchdogLastActivityAtMs = state.chatStreamStartedAt ?? now;
  }
  state.chatRunWatchdogTimer = setTimeout(() => {
    if (state.chatRunId !== runId) {
      return;
    }
    const lastActivityAt =
      state.chatRunWatchdogLastActivityAtMs ?? state.chatStreamStartedAt ?? now;
    const idleForMs = Date.now() - lastActivityAt;
    if (idleForMs < timeoutMs) {
      scheduleRunWatchdog(state);
      return;
    }
    void recoverFromRunWatchdog(state);
  }, timeoutMs);
}

function touchRunWatchdog(state: ChatState) {
  if (!state.chatRunId) {
    return;
  }
  state.chatRunWatchdogLastActivityAtMs = Date.now();
  scheduleRunWatchdog(state);
}

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = await state.client.request<{ messages?: Array<unknown>; thinkingLevel?: string }>(
      "chat.history",
      {
        sessionKey: state.sessionKey,
        limit: 200,
      },
    );
    const messages = Array.isArray(res.messages) ? res.messages : [];
    state.chatMessages = messages.filter((message) => !isAssistantSilentReply(message));
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : roleValue.toLowerCase();
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }

  const now = Date.now();

  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;
  state.chatRunWatchdogLastActivityAtMs = now;
  scheduleRunWatchdog(state);

  // Convert attachments to API format
  const apiAttachments = hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) {
            return null;
          }
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments,
    });
    return runId;
  } catch (err) {
    const error = String(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    clearRunWatchdog(state);
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  if (!sessionKeysMatch(payload.sessionKey, state.sessionKey)) {
    return null;
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage && !isAssistantSilentReply(finalMessage)) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    touchRunWatchdog(state);
    const next = extractText(payload.message);
    if (typeof next === "string" && !isSilentReplyStream(next)) {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage && !isAssistantSilentReply(finalMessage)) {
      state.chatMessages = [...state.chatMessages, finalMessage];
    } else if (state.chatStream?.trim() && !isSilentReplyStream(state.chatStream)) {
      state.chatMessages = [
        ...state.chatMessages,
        {
          role: "assistant",
          content: [{ type: "text", text: state.chatStream }],
          timestamp: Date.now(),
        },
      ];
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    clearRunWatchdog(state);
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !isAssistantSilentReply(normalizedMessage)) {
      state.chatMessages = [...state.chatMessages, normalizedMessage];
    } else {
      const streamedText = state.chatStream ?? "";
      if (streamedText.trim() && !isSilentReplyStream(streamedText)) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: streamedText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    clearRunWatchdog(state);
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    clearRunWatchdog(state);
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
