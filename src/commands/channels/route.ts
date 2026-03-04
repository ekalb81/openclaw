import { normalizeChatType } from "../../channels/chat-type.js";
import { danger } from "../../globals.js";
import {
  buildAgentSessionKey,
  resolveAgentRoute,
  type ResolveAgentRouteInput,
  type RoutePeer,
} from "../../routing/resolve-route.js";
import { DEFAULT_ACCOUNT_ID, resolveThreadSessionKeys } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import { requireValidConfig } from "./shared.js";

export type ChannelsRouteOptions = {
  channel?: string;
  account?: string;
  peerKind?: string;
  peer?: string;
  parentPeerKind?: string;
  parentPeer?: string;
  guildId?: string;
  teamId?: string;
  role?: string | string[];
  threadId?: string;
  threadSuffix?: boolean;
  json?: boolean;
};

type RouteInspectionPayload = {
  input: {
    channel: string;
    accountId: string;
    peer: RoutePeer | null;
    parentPeer: RoutePeer | null;
    guildId: string | null;
    teamId: string | null;
    memberRoleIds: string[];
    threadId: string | null;
    threadSuffix: boolean;
  };
  route: ReturnType<typeof resolveAgentRoute>;
  thread: {
    sessionKey: string;
    parentSessionKey?: string;
  } | null;
};

function normalizeString(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizeRoleList(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePeer(valueKind: string | undefined, valueId: string | undefined): RoutePeer | null {
  const id = normalizeString(valueId);
  if (!id) {
    return null;
  }
  const normalizedKind = normalizeChatType(valueKind);
  if (!normalizedKind) {
    throw new Error(`Invalid peer kind "${valueKind ?? ""}". Use direct|group|channel.`);
  }
  return { kind: normalizedKind, id };
}

function buildInspectionPayload(params: {
  input: ResolveAgentRouteInput;
  threadId: string | null;
  threadSuffix: boolean;
}): RouteInspectionPayload {
  const route = resolveAgentRoute(params.input);
  const input = params.input;
  const parentSessionKey =
    input.parentPeer && input.parentPeer.id
      ? buildAgentSessionKey({
          agentId: route.agentId,
          channel: route.channel,
          accountId: route.accountId,
          peer: input.parentPeer,
          dmScope: input.cfg.session?.dmScope,
          identityLinks: input.cfg.session?.identityLinks,
        })
      : undefined;
  const thread =
    params.threadId != null
      ? resolveThreadSessionKeys({
          baseSessionKey: route.sessionKey,
          threadId: params.threadId,
          parentSessionKey,
          useSuffix: params.threadSuffix,
        })
      : null;
  return {
    input: {
      channel: route.channel,
      accountId: route.accountId,
      peer: input.peer ?? null,
      parentPeer: input.parentPeer ?? null,
      guildId: normalizeString(input.guildId),
      teamId: normalizeString(input.teamId),
      memberRoleIds: input.memberRoleIds ?? [],
      threadId: params.threadId,
      threadSuffix: params.threadSuffix,
    },
    route,
    thread,
  };
}

function formatRouteInspectionLines(payload: RouteInspectionPayload): string[] {
  const lines: string[] = [];
  lines.push(`Route input: ${payload.input.channel}/${payload.input.accountId}`);
  lines.push(`Matched by: ${payload.route.matchedBy}`);
  lines.push(`Agent: ${payload.route.agentId}`);
  if (payload.input.peer) {
    lines.push(`Peer: ${payload.input.peer.kind}:${payload.input.peer.id}`);
  } else {
    lines.push("Peer: none");
  }
  if (payload.input.parentPeer) {
    lines.push(`Parent peer: ${payload.input.parentPeer.kind}:${payload.input.parentPeer.id}`);
  }
  if (payload.input.guildId) {
    lines.push(`Guild: ${payload.input.guildId}`);
  }
  if (payload.input.teamId) {
    lines.push(`Team: ${payload.input.teamId}`);
  }
  if (payload.input.memberRoleIds.length > 0) {
    lines.push(`Roles: ${payload.input.memberRoleIds.join(", ")}`);
  }
  lines.push(`Session key: ${payload.route.sessionKey}`);
  lines.push(`Main session key: ${payload.route.mainSessionKey}`);
  if (payload.thread) {
    lines.push(`Thread session key: ${payload.thread.sessionKey}`);
    if (payload.thread.parentSessionKey) {
      lines.push(`Thread parent session key: ${payload.thread.parentSessionKey}`);
    }
  }
  return lines;
}

export async function channelsRouteCommand(opts: ChannelsRouteOptions, runtime: RuntimeEnv) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }
  const channel = normalizeString(opts.channel);
  if (!channel) {
    runtime.error(danger("Missing required --channel."));
    runtime.exit(1);
    return;
  }

  let peer: RoutePeer | null = null;
  let parentPeer: RoutePeer | null = null;
  try {
    peer = parsePeer(opts.peerKind ?? "direct", opts.peer);
    parentPeer = parsePeer(opts.parentPeerKind ?? "channel", opts.parentPeer);
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
    return;
  }
  const memberRoleIds = normalizeRoleList(opts.role);
  const threadId = normalizeString(opts.threadId);
  const threadSuffix = opts.threadSuffix !== false;
  const input: ResolveAgentRouteInput = {
    cfg,
    channel,
    accountId: normalizeString(opts.account) ?? DEFAULT_ACCOUNT_ID,
    peer,
    parentPeer,
    guildId: normalizeString(opts.guildId),
    teamId: normalizeString(opts.teamId),
    memberRoleIds,
  };
  const payload = buildInspectionPayload({
    input,
    threadId,
    threadSuffix,
  });

  if (opts.json) {
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }
  runtime.log(formatRouteInspectionLines(payload).join("\n"));
}

export const __testing = {
  buildInspectionPayload,
  normalizeRoleList,
  parsePeer,
  formatRouteInspectionLines,
};
