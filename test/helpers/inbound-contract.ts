import { expect } from "vitest";
import type { MsgContext } from "../../src/auto-reply/templating.js";
import { normalizeChatType } from "../../src/channels/chat-type.js";
import { resolveConversationLabel } from "../../src/channels/conversation-label.js";
import { validateSenderIdentity } from "../../src/channels/sender-identity.js";
import type { ResolvedAgentRoute } from "../../src/routing/resolve-route.js";
import { parseAgentSessionKey } from "../../src/routing/session-key.js";

export function expectInboundContextContract(ctx: MsgContext) {
  expect(validateSenderIdentity(ctx)).toEqual([]);

  expect(ctx.Body).toBeTypeOf("string");
  expect(ctx.BodyForAgent).toBeTypeOf("string");
  expect(ctx.BodyForCommands).toBeTypeOf("string");

  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType && chatType !== "direct") {
    const label = ctx.ConversationLabel?.trim() || resolveConversationLabel(ctx);
    expect(label).toBeTruthy();
  }
}

export function expectResolvedRouteContract(route: ResolvedAgentRoute) {
  expect(route.agentId).toBeTruthy();
  expect(route.channel).toBeTruthy();
  expect(route.accountId).toBeTruthy();
  expect(route.matchedBy).toBeTruthy();
  expect(parseAgentSessionKey(route.sessionKey)).toBeTruthy();
  expect(route.mainSessionKey).toBe(`agent:${route.agentId}:main`);
}
