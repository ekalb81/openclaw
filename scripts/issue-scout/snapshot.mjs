#!/usr/bin/env node

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = (process.env.ISSUE_SCOUT_OUT_DIR ?? path.join(".local", "issue-scout")).trim();
const SNAPSHOT_PATH = path.join(OUT_DIR, "snapshot.json");
const DEFAULT_TEXT_LIMIT = 60_000;
const DEFAULT_CMD_MAX_BUFFER = 30 * 1024 * 1024;

function clampText(value, max = DEFAULT_TEXT_LIMIT) {
  if (typeof value !== "string") {
    return "";
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

function runCommand(command) {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: DEFAULT_CMD_MAX_BUFFER,
    });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    return `${stdout}${stderr}`.trim();
  }
}

function readTextIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveRepoSlug() {
  const fromEnv = process.env.GITHUB_REPOSITORY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const remoteUrl = runCommand("git config --get remote.origin.url").trim();
  if (!remoteUrl) {
    return "";
  }
  const normalized = remoteUrl.replace(/\.git$/, "");
  if (normalized.startsWith("git@github.com:")) {
    return normalized.slice("git@github.com:".length);
  }
  if (normalized.startsWith("https://github.com/")) {
    return normalized.slice("https://github.com/".length);
  }
  return normalized;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const snapshot = {
    createdAt: new Date().toISOString(),
    repo: resolveRepoSlug(),
    branch: runCommand("git rev-parse --abbrev-ref HEAD").trim(),
    head: runCommand("git rev-parse HEAD").trim(),
    tree: clampText(runCommand("git ls-files")),
    recentCommits: clampText(runCommand("git log -n 40 --oneline")),
    todos: clampText(runCommand("git grep -nE \"TODO|FIXME\" -- src scripts .github")),
    packageJson: readJsonIfExists("package.json"),
    checks: {
      lint: clampText(readTextIfExists(path.join(OUT_DIR, "lint.txt"))),
      tests: clampText(readTextIfExists(path.join(OUT_DIR, "test.txt"))),
      typecheck: clampText(readTextIfExists(path.join(OUT_DIR, "typecheck.txt"))),
    },
  };

  fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log(`wrote ${SNAPSHOT_PATH}`);
}

main();
