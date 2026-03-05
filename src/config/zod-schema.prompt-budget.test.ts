import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("agent defaults prompt budget schema", () => {
  it("accepts global and per-model prompt budget controls", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        promptBudget: {
          enabled: true,
          profile: "throughput",
          profiles: {
            throughput: {
              softLimitRatio: 0.8,
              hardLimitRatio: 0.92,
            },
          },
          charsPerToken: 4,
          imageTokens: 1000,
          softLimitRatio: 0.7,
          hardLimitRatio: 0.85,
          softAction: "trim",
          hardAction: "block",
        },
        models: {
          "openai/gpt-5.2": {
            promptBudget: {
              softAction: "warn",
              hardAction: "summarize",
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects invalid prompt budget actions", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        promptBudget: {
          softAction: "block",
        },
      }),
    ).toThrow();

    expect(() =>
      AgentDefaultsSchema.parse({
        promptBudget: {
          hardAction: "warn",
        },
      }),
    ).toThrow();
  });

  it("accepts context pruning policy enum", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        contextPruning: {
          mode: "cache-ttl",
          policy: "all",
        },
      }),
    ).not.toThrow();
  });

  it("accepts cost-aware model routing tiers and OpenRouter passthrough", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        modelRouting: {
          enabled: true,
          tier: "economy",
          tierOrder: ["economy", "balanced", "premium"],
          tiers: {
            economy: { primary: "openai/gpt-5-mini", fallbacks: ["openrouter/auto"] },
            balanced: { primary: "anthropic/claude-sonnet-4-5" },
            premium: { primary: "openai/gpt-5.2" },
          },
          openRouter: {
            providerByTier: {
              economy: {
                order: ["anthropic", "openai"],
                allow_fallbacks: true,
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts tool-result context compaction controls", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        compaction: {
          toolResultContext: {
            enabled: true,
            maxToolPayloadChars: 12000,
            summaryAfterTurns: 2,
            maxToolMessagesInContext: 6,
          },
        },
      }),
    ).not.toThrow();
  });
});
