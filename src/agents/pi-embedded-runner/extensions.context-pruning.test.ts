import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentContextPruningConfig } from "../../config/types.agent-defaults.js";
import contextPruningExtension from "../pi-extensions/context-pruning.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

const stubSessionManager = {} as Parameters<
  typeof buildEmbeddedExtensionFactories
>[0]["sessionManager"];

function createBaseConfig(contextPruning?: AgentContextPruningConfig): OpenClawConfig {
  return {
    agents: {
      defaults: {
        compaction: {
          mode: "default",
        },
        contextPruning,
      },
    },
  };
}

describe("buildEmbeddedExtensionFactories context pruning", () => {
  it("enables default pruning for eligible providers", () => {
    const factories = buildEmbeddedExtensionFactories({
      cfg: createBaseConfig(),
      sessionManager: stubSessionManager,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      model: { contextWindow: 200_000 } as never,
    });

    expect(factories).toContain(contextPruningExtension);
  });

  it("does not enable default pruning for ineligible providers", () => {
    const factories = buildEmbeddedExtensionFactories({
      cfg: createBaseConfig(),
      sessionManager: stubSessionManager,
      provider: "openai",
      modelId: "gpt-5.2",
      model: { contextWindow: 200_000 } as never,
    });

    expect(factories).not.toContain(contextPruningExtension);
  });

  it("allows policy override to all providers", () => {
    const factories = buildEmbeddedExtensionFactories({
      cfg: createBaseConfig({
        mode: "cache-ttl",
        policy: "all",
      }),
      sessionManager: stubSessionManager,
      provider: "openai",
      modelId: "gpt-5.2",
      model: { contextWindow: 200_000 } as never,
    });

    expect(factories).toContain(contextPruningExtension);
  });

  it("respects explicit off switch", () => {
    const factories = buildEmbeddedExtensionFactories({
      cfg: createBaseConfig({ mode: "off" }),
      sessionManager: stubSessionManager,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      model: { contextWindow: 200_000 } as never,
    });

    expect(factories).not.toContain(contextPruningExtension);
  });
});
