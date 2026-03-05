import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearPendingGroupHistoryAfterDispatch,
  dispatchInboundMessage,
  withReplyDispatcher,
} from "./dispatch.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import { buildTestCtx } from "./reply/test-ctx.js";

function createDispatcher(record: string[]): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {
      record.push("markComplete");
    },
    waitForIdle: async () => {
      record.push("waitForIdle");
    },
  };
}

describe("withReplyDispatcher", () => {
  it("always marks complete and waits for idle after success", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);

    const result = await withReplyDispatcher({
      dispatcher,
      run: async () => {
        order.push("run");
        return "ok";
      },
      onSettled: () => {
        order.push("onSettled");
      },
    });

    expect(result).toBe("ok");
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("still drains dispatcher after run throws", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);
    const onSettled = vi.fn(() => {
      order.push("onSettled");
    });

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: async () => {
          order.push("run");
          throw new Error("boom");
        },
        onSettled,
      }),
    ).rejects.toThrow("boom");

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("dispatchInboundMessage owns dispatcher lifecycle", async () => {
    const order: string[] = [];
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => {
        order.push("sendFinalReply");
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {
        order.push("markComplete");
      },
      waitForIdle: async () => {
        order.push("waitForIdle");
      },
    } satisfies ReplyDispatcher;

    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });
});

describe("clearPendingGroupHistoryAfterDispatch", () => {
  it("clears pending history for grouped conversations with a key", () => {
    const history = new Map([
      [
        "group-1",
        [
          {
            sender: "alice",
            body: "hello",
            timestamp: Date.now(),
            messageId: "m1",
          },
        ],
      ],
    ]);
    clearPendingGroupHistoryAfterDispatch({
      isGroup: true,
      historyKey: "group-1",
      historyLimit: 5,
      historyMap: history,
    });
    expect(history.get("group-1")).toEqual([]);
  });

  it("skips history cleanup for non-group inbound", () => {
    const history = new Map([
      [
        "group-1",
        [
          {
            sender: "alice",
            body: "hello",
            timestamp: Date.now(),
            messageId: "m1",
          },
        ],
      ],
    ]);
    clearPendingGroupHistoryAfterDispatch({
      isGroup: false,
      historyKey: "group-1",
      historyLimit: 5,
      historyMap: history,
    });
    expect(history.get("group-1")?.length).toBe(1);
  });

  it("skips history cleanup when group key is missing", () => {
    const history = new Map([
      [
        "group-1",
        [
          {
            sender: "alice",
            body: "hello",
            timestamp: Date.now(),
            messageId: "m1",
          },
        ],
      ],
    ]);
    clearPendingGroupHistoryAfterDispatch({
      isGroup: true,
      historyKey: undefined,
      historyLimit: 5,
      historyMap: history,
    });
    expect(history.get("group-1")?.length).toBe(1);
  });
});
