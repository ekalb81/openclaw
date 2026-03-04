import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderUsageInsights } from "./usage-render-overview.ts";
import type { UsageAggregates, UsageTotals } from "./usageTypes.ts";

const describeDom = typeof document === "undefined" ? describe.skip : describe;

function makeTotals(): UsageTotals {
  return {
    input: 100,
    output: 50,
    cacheRead: 25,
    cacheWrite: 10,
    totalTokens: 185,
    totalCost: 1.25,
    inputCost: 0.4,
    outputCost: 0.7,
    cacheReadCost: 0.1,
    cacheWriteCost: 0.05,
    missingCostEntries: 0,
  };
}

function makeAggregates(): UsageAggregates {
  return {
    messages: { total: 10, user: 5, assistant: 5, toolCalls: 0, toolResults: 0, errors: 0 },
    tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
    byModel: [],
    byProvider: [],
    byAgent: [],
    byChannel: [],
    promptFootprint: {
      turns: 4,
      blockedTurns: 1,
      changedTurns: 2,
      avgEstimatedTokens: 900,
      maxEstimatedTokens: 1200,
      profiles: [
        {
          profile: "throughput",
          turns: 3,
          blockedTurns: 1,
          changedTurns: 1,
          avgEstimatedTokens: 850,
          maxEstimatedTokens: 1200,
        },
      ],
    },
    daily: [],
  };
}

describeDom("usage render overview", () => {
  it("renders prompt footprint summary and profile list", () => {
    const container = document.createElement("div");
    render(
      renderUsageInsights(
        makeTotals(),
        makeAggregates(),
        {
          durationSumMs: 1000,
          durationCount: 1,
          avgDurationMs: 1000,
          throughputTokensPerMin: 200,
          throughputCostPerMin: 0.2,
          errorRate: 0,
        },
        false,
        [],
        1,
        1,
      ),
      container,
    );

    expect(container.textContent).toContain("Prompt Footprint");
    expect(container.textContent).toContain("throughput");
    expect(container.textContent).toContain("4 turns");
  });
});
