import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER,
  STALE_TOOL_RESULT_COMPACTION_PREFIX,
  installToolResultContextGuard,
} from "./tool-result-context-guard.js";

function makeUser(text: string): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

function makeToolResult(id: string, text: string): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  });
}

function makeLegacyToolResult(id: string, text: string): AgentMessage {
  return castAgentMessage({
    role: "tool",
    tool_call_id: id,
    tool_name: "read",
    content: text,
  });
}

function makeToolResultWithDetails(id: string, text: string, detailText: string): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    details: {
      truncation: {
        truncated: true,
        outputLines: 100,
        content: detailText,
      },
    },
    isError: false,
    timestamp: Date.now(),
  });
}

function makeAssistant(text: string): AgentMessage {
  return castAgentMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
}

function getToolResultText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const block = content.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

function makeGuardableAgent(
  transformContext?: (
    messages: AgentMessage[],
    signal: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>,
) {
  return { transformContext };
}

function makeTwoToolResultOverflowContext(): AgentMessage[] {
  return [
    makeUser("u".repeat(2_000)),
    makeToolResult("call_old", "x".repeat(1_000)),
    makeToolResult("call_new", "y".repeat(1_000)),
  ];
}

async function applyGuardToContext(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  contextForNextCall: AgentMessage[],
  options?: {
    contextWindowTokens?: number;
    policy?: Parameters<typeof installToolResultContextGuard>[0]["policy"];
  },
): Promise<AgentMessage[]> {
  installToolResultContextGuard({
    agent,
    contextWindowTokens: options?.contextWindowTokens ?? 1_000,
    policy: options?.policy,
  });
  const transformed = await agent.transformContext?.(
    contextForNextCall,
    new AbortController().signal,
  );
  return (Array.isArray(transformed) ? transformed : contextForNextCall) as AgentMessage[];
}

function expectCompactedToolResultsWithoutContextNotice(
  contextForNextCall: AgentMessage[],
  oldIndex: number,
  newIndex: number,
) {
  const oldResultText = getToolResultText(contextForNextCall[oldIndex]);
  const newResultText = getToolResultText(contextForNextCall[newIndex]);
  expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  expect(newResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  expect(newResultText).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
}

describe("installToolResultContextGuard", () => {
  it("compacts oldest-first when total context overflows, even if each result fits individually", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = makeTwoToolResultOverflowContext();
    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).not.toBe(contextForNextCall);
    expectCompactedToolResultsWithoutContextNotice(transformed, 1, 2);
    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(1_000));
    expect(getToolResultText(contextForNextCall[2])).toBe("y".repeat(1_000));
  });

  it("keeps compacting oldest-first until context is back under budget", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(2_200)),
      makeToolResult("call_1", "a".repeat(800)),
      makeToolResult("call_2", "b".repeat(800)),
      makeToolResult("call_3", "c".repeat(800)),
    ];

    const transformed = (await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    )) as AgentMessage[];

    const first = getToolResultText(transformed[1]);
    const second = getToolResultText(transformed[2]);
    const third = getToolResultText(transformed[3]);

    expect(first).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(second).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(third).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("survives repeated large tool results by compacting older outputs before later turns", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 100_000,
    });

    const contextForNextCall: AgentMessage[] = [makeUser("stress")];
    let transformed: AgentMessage[] = contextForNextCall;
    for (let i = 1; i <= 4; i++) {
      contextForNextCall.push(makeToolResult(`call_${i}`, String(i).repeat(95_000)));
      transformed = (await agent.transformContext?.(
        contextForNextCall,
        new AbortController().signal,
      )) as AgentMessage[];
    }

    const toolResultTexts = transformed
      .filter((msg) => msg.role === "toolResult")
      .map((msg) => getToolResultText(msg as AgentMessage));

    const firstResultText = toolResultTexts[0] ?? "";
    expect(
      firstResultText === PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER ||
        firstResultText.includes(STALE_TOOL_RESULT_COMPACTION_PREFIX),
    ).toBe(true);
    expect(firstResultText).not.toBe("1".repeat(95_000));
    expect(toolResultTexts[3]?.length ?? 0).toBeGreaterThan(0);
    expect(toolResultTexts.join("\n")).not.toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("truncates an individually oversized tool result with a context-limit notice", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [makeToolResult("call_big", "z".repeat(5_000))];

    const transformed = (await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    )) as AgentMessage[];

    const newResultText = getToolResultText(transformed[0]);
    expect(newResultText.length).toBeLessThan(5_000);
    expect(newResultText).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  });

  it("keeps compacting oldest-first until overflow clears, including the newest tool result when needed", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(2_600)),
      makeToolResult("call_old", "x".repeat(700)),
      makeToolResult("call_new", "y".repeat(1_000)),
    ];

    const transformed = (await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    )) as AgentMessage[];
    expectCompactedToolResultsWithoutContextNotice(transformed, 1, 2);
  });

  it("wraps an existing transformContext and guards the transformed output", async () => {
    const agent = makeGuardableAgent((messages) => {
      return messages.map((msg) =>
        castAgentMessage({
          ...(msg as unknown as Record<string, unknown>),
        }),
      );
    });
    const contextForNextCall = makeTwoToolResultOverflowContext();
    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).not.toBe(contextForNextCall);
    const oldResultText = getToolResultText(transformed[1]);
    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("handles legacy role=tool string outputs when enforcing context budget", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(2_000)),
      makeLegacyToolResult("call_old", "x".repeat(1_000)),
      makeLegacyToolResult("call_new", "y".repeat(1_000)),
    ];

    const transformed = (await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    )) as AgentMessage[];

    const oldResultText = (transformed[1] as { content?: unknown }).content;
    const newResultText = (transformed[2] as { content?: unknown }).content;

    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(newResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  });

  it("drops oversized read-tool details payloads when compacting tool results", async () => {
    const agent = makeGuardableAgent();

    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
    });

    const contextForNextCall = [
      makeUser("u".repeat(1_600)),
      makeToolResultWithDetails("call_old", "x".repeat(900), "d".repeat(8_000)),
      makeToolResultWithDetails("call_new", "y".repeat(900), "d".repeat(8_000)),
    ];

    const transformed = (await agent.transformContext?.(
      contextForNextCall,
      new AbortController().signal,
    )) as AgentMessage[];

    const oldResult = transformed[1] as {
      details?: unknown;
    };
    const newResult = transformed[2] as {
      details?: unknown;
    };
    const oldResultText = getToolResultText(transformed[1]);
    const newResultText = getToolResultText(transformed[2]);

    expect(oldResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(newResultText).toBe(PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    expect(oldResult.details).toBeUndefined();
    expect(newResult.details).toBeUndefined();
  });

  it("summarizes stale tool results with transcript pointers after assistant turns", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("question"),
      makeToolResult("call_old", "x".repeat(600)),
      makeAssistant("noted"),
      makeAssistant("continuing"),
      makeToolResult("call_new", "fresh output"),
    ];

    const transformed = await applyGuardToContext(agent, contextForNextCall, {
      contextWindowTokens: 30_000,
      policy: {
        summaryAfterTurns: 1,
        maxToolPayloadChars: 10_000,
        maxToolMessagesInContext: 10,
      },
    });

    const oldResultText = getToolResultText(transformed[1]);
    const newResultText = getToolResultText(transformed[4]);
    expect(oldResultText).toContain(STALE_TOOL_RESULT_COMPACTION_PREFIX);
    expect(oldResultText).toContain("tool=read");
    expect(oldResultText).toContain("ref=toolCallId:call_old");
    expect(newResultText).toBe("fresh output");
    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(600));
  });

  it("summarizes oldest tool messages when maxToolMessagesInContext is exceeded", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("question"),
      makeToolResult("call_1", "oldest"),
      makeToolResult("call_2", "middle"),
      makeToolResult("call_3", "newest"),
    ];

    const transformed = await applyGuardToContext(agent, contextForNextCall, {
      contextWindowTokens: 30_000,
      policy: {
        summaryAfterTurns: 999,
        maxToolPayloadChars: 10_000,
        maxToolMessagesInContext: 1,
      },
    });

    expect(getToolResultText(transformed[1])).toContain(STALE_TOOL_RESULT_COMPACTION_PREFIX);
    expect(getToolResultText(transformed[2])).toContain(STALE_TOOL_RESULT_COMPACTION_PREFIX);
    expect(getToolResultText(transformed[3])).toBe("newest");
  });

  it("supports disabling stale tool summarization with policy.enabled=false", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("question"),
      makeToolResult("call_old", "x".repeat(600)),
      makeAssistant("reply"),
    ];

    const transformed = await applyGuardToContext(agent, contextForNextCall, {
      contextWindowTokens: 30_000,
      policy: {
        enabled: false,
        summaryAfterTurns: 0,
        maxToolPayloadChars: 10,
        maxToolMessagesInContext: 1,
      },
    });

    expect(getToolResultText(transformed[1])).toBe("x".repeat(600));
    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(600));
  });
});
