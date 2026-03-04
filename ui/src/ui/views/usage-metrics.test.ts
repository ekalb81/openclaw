import { describe, expect, it } from "vitest";
import { buildAggregatesFromSessions } from "./usage-metrics.ts";
import type { UsageSessionEntry } from "./usageTypes.ts";

function makeSession(params: {
  key: string;
  profile: string;
  turns: number;
  avgEstimatedTokens: number;
  blockedTurns?: number;
  changedTurns?: number;
}): UsageSessionEntry {
  return {
    key: params.key,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    },
    promptFootprint: {
      turns: params.turns,
      blockedTurns: params.blockedTurns ?? 0,
      changedTurns: params.changedTurns ?? 0,
      avgEstimatedTokens: params.avgEstimatedTokens,
      maxEstimatedTokens: params.avgEstimatedTokens,
      profiles: [
        {
          profile: params.profile,
          turns: params.turns,
          blockedTurns: params.blockedTurns ?? 0,
          changedTurns: params.changedTurns ?? 0,
          avgEstimatedTokens: params.avgEstimatedTokens,
          maxEstimatedTokens: params.avgEstimatedTokens,
        },
      ],
    },
  } as UsageSessionEntry;
}

describe("buildAggregatesFromSessions prompt footprint", () => {
  it("merges prompt footprint turns and profile stats across sessions", () => {
    const aggregates = buildAggregatesFromSessions([
      makeSession({
        key: "a",
        profile: "balanced",
        turns: 2,
        avgEstimatedTokens: 1200,
        changedTurns: 1,
      }),
      makeSession({
        key: "b",
        profile: "throughput",
        turns: 3,
        avgEstimatedTokens: 900,
        blockedTurns: 1,
      }),
    ]);

    expect(aggregates.promptFootprint).toBeDefined();
    expect(aggregates.promptFootprint?.turns).toBe(5);
    expect(aggregates.promptFootprint?.blockedTurns).toBe(1);
    expect(aggregates.promptFootprint?.changedTurns).toBe(1);
    expect(aggregates.promptFootprint?.avgEstimatedTokens).toBe(1020);
    expect(aggregates.promptFootprint?.profiles).toEqual([
      expect.objectContaining({ profile: "throughput", turns: 3 }),
      expect.objectContaining({ profile: "balanced", turns: 2 }),
    ]);
  });
});
