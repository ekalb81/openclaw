import { listChannelPlugins } from "../channels/plugins/index.js";
import { GATEWAY_EVENT_UPDATE_AVAILABLE } from "./events.js";
import { coreGatewayHandlers } from "./server-methods.js";

export function listCoreGatewayMethods(): string[] {
  return Object.keys(coreGatewayHandlers).toSorted((a, b) => a.localeCompare(b));
}

export function listGatewayMethods(): string[] {
  const channelMethods = listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []);
  return Array.from(new Set([...listCoreGatewayMethods(), ...channelMethods])).toSorted((a, b) =>
    a.localeCompare(b),
  );
}

export const GATEWAY_EVENTS = [
  "connect.challenge",
  "agent",
  "chat",
  "presence",
  "tick",
  "talk.mode",
  "shutdown",
  "health",
  "heartbeat",
  "cron",
  "node.pair.requested",
  "node.pair.resolved",
  "node.invoke.request",
  "device.pair.requested",
  "device.pair.resolved",
  "voicewake.changed",
  "exec.approval.requested",
  "exec.approval.resolved",
  GATEWAY_EVENT_UPDATE_AVAILABLE,
];
