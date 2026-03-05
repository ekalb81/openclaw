import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolvePromptBudgetSettings,
  resolveContextWindowInfo,
  runPromptBudgetPreflight,
  trimMessagesToPromptBudget,
} from "./context-window-guard.js";

describe("context-window-guard", () => {
  it("blocks below 16k (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 8000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.source).toBe("model");
    expect(guard.tokens).toBe(8000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(true);
  });

  it("warns below 32k but does not block at 16k+", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "small",
      modelContextWindow: 24_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.tokens).toBe(24_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not warn at 32k+ (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "ok",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("uses models.providers.*.models[].contextWindow when present", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "tiny",
                name: "tiny",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 12_000,
                maxTokens: 256,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("modelsConfig");
    expect(guard.shouldBlock).toBe(true);
  });

  it("caps with agents.defaults.contextTokens", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 20_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      provider: "anthropic",
      modelId: "whatever",
      modelContextWindow: 200_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("agentContextTokens");
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not override when cap exceeds base window", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 128_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      provider: "anthropic",
      modelId: "whatever",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    expect(info.source).toBe("model");
    expect(info.tokens).toBe(64_000);
  });

  it("uses default when nothing else is available", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "anthropic",
      modelId: "unknown",
      modelContextWindow: undefined,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("default");
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("allows overriding thresholds", () => {
    const info = { tokens: 10_000, source: "model" as const };
    const guard = evaluateContextWindowGuard({
      info,
      warnBelowTokens: 12_000,
      hardMinTokens: 9_000,
    });
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("resolves prompt-budget defaults", () => {
    const settings = resolvePromptBudgetSettings({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5.2",
    });
    expect(settings.enabled).toBe(true);
    expect(settings.profile).toBe("balanced");
    expect(settings.charsPerToken).toBe(4);
    expect(settings.imageTokens).toBe(1200);
    expect(settings.softLimitRatio).toBe(0.7);
    expect(settings.hardLimitRatio).toBe(0.85);
    expect(settings.softAction).toBe("trim");
    expect(settings.hardAction).toBe("block");
  });

  it("applies per-model prompt-budget overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          promptBudget: {
            softLimitRatio: 0.6,
            hardAction: "block",
          },
          models: {
            "openai/gpt-5.2": {
              promptBudget: {
                softAction: "warn",
                hardAction: "trim",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const settings = resolvePromptBudgetSettings({
      cfg,
      provider: "openai",
      modelId: "gpt-5.2",
    });
    expect(settings.softLimitRatio).toBe(0.6);
    expect(settings.softAction).toBe("warn");
    expect(settings.hardAction).toBe("trim");
  });

  it("applies configured prompt-budget profile defaults", () => {
    const cfg = {
      agents: {
        defaults: {
          promptBudget: {
            profile: "throughput",
          },
        },
      },
    } satisfies OpenClawConfig;

    const settings = resolvePromptBudgetSettings({
      cfg,
      provider: "openai",
      modelId: "gpt-5.2",
    });
    expect(settings.profile).toBe("throughput");
    expect(settings.softAction).toBe("warn");
    expect(settings.hardAction).toBe("trim");
    expect(settings.softLimitRatio).toBe(0.78);
    expect(settings.hardLimitRatio).toBe(0.92);
  });

  it("resolves custom prompt-budget profile and allows model overrides on top", () => {
    const cfg = {
      agents: {
        defaults: {
          promptBudget: {
            profile: "latency",
            profiles: {
              latency: {
                softLimitRatio: 0.82,
                hardLimitRatio: 0.95,
                softAction: "warn",
                hardAction: "trim",
              },
            },
          },
          models: {
            "openai/gpt-5.2": {
              promptBudget: {
                hardAction: "block",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const settings = resolvePromptBudgetSettings({
      cfg,
      provider: "openai",
      modelId: "gpt-5.2",
    });
    expect(settings.profile).toBe("latency");
    expect(settings.softLimitRatio).toBe(0.82);
    expect(settings.hardLimitRatio).toBe(0.95);
    expect(settings.softAction).toBe("warn");
    expect(settings.hardAction).toBe("block");
  });

  it("trim helper keeps the newest message when budget is extremely tight", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "a".repeat(1000), timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "b".repeat(1000) }], timestamp: 2 },
    ] as AgentMessage[];

    const trimmed = trimMessagesToPromptBudget({
      messages,
      maxInputTokens: 10,
      promptChars: 3000,
      systemChars: 2000,
      imageTokens: 0,
      charsPerToken: 4,
    });

    expect(trimmed.messages).toHaveLength(1);
    expect(trimmed.messages[0]?.role).toBe("assistant");
    expect(trimmed.droppedMessages).toBe(1);
  });

  it("preflight soft-trims history when soft limit is exceeded", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "a".repeat(1800), timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "b".repeat(1800) }], timestamp: 2 },
      { role: "user", content: "c".repeat(1800), timestamp: 3 },
    ] as AgentMessage[];

    const result = runPromptBudgetPreflight({
      messages,
      prompt: "hello",
      contextWindowTokens: 1200,
      settings: {
        enabled: true,
        charsPerToken: 4,
        imageTokens: 0,
        softLimitRatio: 0.4,
        hardLimitRatio: 0.95,
        softAction: "trim",
        hardAction: "block",
      },
    });

    expect(result.changed).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.events.some((event) => event.phase === "soft" && event.action === "trim")).toBe(
      true,
    );
  });

  it("preflight blocks when hard limit stays exceeded", () => {
    const result = runPromptBudgetPreflight({
      messages: [],
      prompt: "x".repeat(8000),
      contextWindowTokens: 1500,
      settings: {
        enabled: true,
        charsPerToken: 4,
        imageTokens: 0,
        softLimitRatio: 0.5,
        hardLimitRatio: 0.8,
        softAction: "trim",
        hardAction: "block",
      },
    });

    expect(result.changed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.events.some((event) => event.phase === "hard" && event.action === "block")).toBe(
      true,
    );
  });

  it("treats summarize action as trim behavior with a note", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "a".repeat(1800), timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "b".repeat(1800) }], timestamp: 2 },
      { role: "user", content: "c".repeat(1800), timestamp: 3 },
    ] as AgentMessage[];

    const result = runPromptBudgetPreflight({
      messages,
      prompt: "hello",
      contextWindowTokens: 1000,
      settings: {
        enabled: true,
        charsPerToken: 4,
        imageTokens: 0,
        softLimitRatio: 0.95,
        hardLimitRatio: 0.5,
        softAction: "warn",
        hardAction: "summarize",
      },
    });

    const summarizeEvent = result.events.find(
      (event) => event.phase === "hard" && event.action === "summarize",
    );
    expect(summarizeEvent?.note).toContain("trim behavior");
    expect(result.blocked).toBe(false);
  });

  it("exports thresholds as expected", () => {
    expect(CONTEXT_WINDOW_HARD_MIN_TOKENS).toBe(16_000);
    expect(CONTEXT_WINDOW_WARN_BELOW_TOKENS).toBe(32_000);
  });
});
