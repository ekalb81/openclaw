import fs from "node:fs/promises";
import { normalizeScpRemoteHost } from "../../infra/scp-host.js";

type ReadFileFn = (path: string, encoding: BufferEncoding) => Promise<string>;

function resolveCliPath(cliPath: string, homeDir?: string): string {
  if (!cliPath.startsWith("~")) {
    return cliPath;
  }
  const resolvedHome = homeDir ?? process.env.HOME ?? "";
  return cliPath.replace(/^~/, resolvedHome);
}

/**
 * Try to detect a remote host from an SSH wrapper script like:
 *   exec ssh -T openclaw@192.168.64.3 /opt/homebrew/bin/imsg "$@"
 *   exec ssh -T mac-mini imsg "$@"
 * Returns the user@host or host portion if found.
 */
export async function detectRemoteHostFromCliPath(
  cliPath: string,
  deps?: {
    readFile?: ReadFileFn;
    homeDir?: string;
  },
): Promise<string | undefined> {
  const readFile = deps?.readFile ?? fs.readFile;
  try {
    const expanded = resolveCliPath(cliPath, deps?.homeDir);
    const content = await readFile(expanded, "utf8");

    // Match user@host pattern first (e.g., openclaw@192.168.64.3)
    const userHostMatch = content.match(/\bssh\b[^\n]*?\s+([^\s"'`]+@[^\s"'`]+)(?=\s)/);
    if (userHostMatch) {
      return userHostMatch[1];
    }

    // Fallback: match host-only before imsg command (e.g., ssh -T mac-mini imsg)
    const hostOnlyMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z][a-zA-Z0-9._-]*)\s+\S*\bimsg\b/);
    return hostOnlyMatch?.[1];
  } catch {
    return undefined;
  }
}

export async function resolveIMessageRemoteHost(params: {
  configuredRemoteHost?: string;
  cliPath?: string;
  logVerbose?: (message: string) => void;
  readFile?: ReadFileFn;
  homeDir?: string;
}): Promise<string | undefined> {
  const configuredRemoteHost = normalizeScpRemoteHost(params.configuredRemoteHost);
  if (params.configuredRemoteHost && !configuredRemoteHost) {
    params.logVerbose?.("imessage: ignoring unsafe channels.imessage.remoteHost value");
  }

  let remoteHost = configuredRemoteHost;
  if (!remoteHost && params.cliPath && params.cliPath !== "imsg") {
    const detected = await detectRemoteHostFromCliPath(params.cliPath, {
      readFile: params.readFile,
      homeDir: params.homeDir,
    });
    const normalizedDetected = normalizeScpRemoteHost(detected);
    if (detected && !normalizedDetected) {
      params.logVerbose?.("imessage: ignoring unsafe auto-detected remoteHost from cliPath");
    }
    remoteHost = normalizedDetected;
    if (remoteHost) {
      params.logVerbose?.(`imessage: detected remoteHost=${remoteHost} from cliPath`);
    }
  }

  return remoteHost;
}
