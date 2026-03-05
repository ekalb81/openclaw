#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const OUT_DIR = (process.env.ISSUE_SCOUT_OUT_DIR ?? path.join(".local", "issue-scout")).trim();
const INPUT_PATH = path.join(OUT_DIR, "issues.json");
const RESULT_PATH = path.join(OUT_DIR, "created-issues.json");
const DEDUPE_MARKER_PREFIX = "<!-- issue-scout:";

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run") || process.env.ISSUE_SCOUT_DRY_RUN === "1",
  };
}

function resolveRepoSlug() {
  const fromEnv = process.env.GITHUB_REPOSITORY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const remote = execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim();
  const normalized = remote.replace(/\.git$/, "");
  if (normalized.startsWith("git@github.com:")) {
    return normalized.slice("git@github.com:".length);
  }
  if (normalized.startsWith("https://github.com/")) {
    return normalized.slice("https://github.com/".length);
  }
  throw new Error("Unable to resolve repository slug.");
}

function normalizeTitle(value) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function ensureDedupeMarker(body, dedupeKey) {
  const marker = `${DEDUPE_MARKER_PREFIX}${dedupeKey} -->`;
  if (body.includes(marker)) {
    return body;
  }
  return `${body.trim()}\n\n${marker}`;
}

async function ghGet(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function ghPost(url, token, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function findByDedupeMarker(repoSlug, token, dedupeKey) {
  const marker = `${DEDUPE_MARKER_PREFIX}${dedupeKey} -->`;
  const query = encodeURIComponent(`repo:${repoSlug} is:issue is:open in:body "${marker}"`);
  const url = `https://api.github.com/search/issues?q=${query}&per_page=5`;
  const result = await ghGet(url, token);
  const items = Array.isArray(result?.items) ? result.items : [];
  return items.length > 0 ? items[0] : null;
}

async function findByTitle(repoSlug, token, title) {
  const query = encodeURIComponent(`repo:${repoSlug} is:issue is:open in:title "${title}"`);
  const url = `https://api.github.com/search/issues?q=${query}&per_page=10`;
  const result = await ghGet(url, token);
  const items = Array.isArray(result?.items) ? result.items : [];
  const normalizedTarget = normalizeTitle(title);
  return (
    items.find((item) => typeof item?.title === "string" && normalizeTitle(item.title) === normalizedTarget) ??
    null
  );
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error("GITHUB_TOKEN is required.");
  }

  const repoSlug = resolveRepoSlug();
  const payload = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const issues = Array.isArray(payload?.issues) ? payload.issues : [];
  const created = [];
  const skipped = [];

  for (const issue of issues) {
    const title = typeof issue?.title === "string" ? issue.title.trim() : "";
    const body = typeof issue?.body === "string" ? issue.body.trim() : "";
    const dedupeKey = typeof issue?.dedupe_key === "string" ? issue.dedupe_key.trim() : "";
    const labels = Array.isArray(issue?.labels)
      ? issue.labels.filter((entry) => typeof entry === "string" && entry.trim())
      : [];

    if (!title || !body || !dedupeKey) {
      skipped.push({ title: title || "<missing-title>", reason: "invalid-issue-shape" });
      continue;
    }

    const markerMatch = await findByDedupeMarker(repoSlug, token, dedupeKey);
    if (markerMatch) {
      skipped.push({
        title,
        reason: "duplicate-dedupe-key",
        existing: markerMatch.html_url ?? markerMatch.url,
      });
      continue;
    }

    const titleMatch = await findByTitle(repoSlug, token, title);
    if (titleMatch) {
      skipped.push({
        title,
        reason: "duplicate-title",
        existing: titleMatch.html_url ?? titleMatch.url,
      });
      continue;
    }

    const finalBody = ensureDedupeMarker(body, dedupeKey);
    if (dryRun) {
      created.push({ title, url: null, dryRun: true });
      continue;
    }

    const createdIssue = await ghPost(`https://api.github.com/repos/${repoSlug}/issues`, token, {
      title,
      body: finalBody,
      labels,
    });
    created.push({
      title,
      number: createdIssue.number,
      url: createdIssue.html_url,
      dryRun: false,
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    RESULT_PATH,
    `${JSON.stringify({ repo: repoSlug, created, skipped, dryRun }, null, 2)}\n`,
  );

  // eslint-disable-next-line no-console
  console.log(
    `issue-scout: created=${created.filter((entry) => !entry.dryRun).length} dryRunCreated=${created.filter((entry) => entry.dryRun).length} skipped=${skipped.length}`,
  );
  // eslint-disable-next-line no-console
  console.log(`wrote ${RESULT_PATH}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
