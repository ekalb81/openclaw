#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const OUT_DIR = (process.env.ISSUE_SCOUT_OUT_DIR ?? path.join(".local", "issue-scout")).trim();
const SNAPSHOT_PATH = path.join(OUT_DIR, "snapshot.json");
const PROMPT_PATH = path.join("scripts", "issue-scout", "prompt.txt");
const OUTPUT_PATH = path.join(OUT_DIR, "issues.json");
const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_PROPOSALS = 8;
const DEFAULT_ENDPOINT_MODE = "auto";

const ALLOWED_LABELS = new Set([
  "bug",
  "enhancement",
  "performance",
  "security",
  "testing",
  "developer-experience",
]);

function resolveEnv() {
  const apiKey =
    process.env.ISSUE_SCOUT_LLM_API_KEY?.trim() ||
    process.env.LLM_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  const baseUrl =
    process.env.ISSUE_SCOUT_LLM_BASE_URL?.trim() || process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const model = process.env.ISSUE_SCOUT_LLM_MODEL?.trim() || process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;
  const rawMax = process.env.ISSUE_SCOUT_MAX_PROPOSALS?.trim();
  const maxProposals = rawMax ? Math.max(1, Number.parseInt(rawMax, 10) || DEFAULT_MAX_PROPOSALS) : DEFAULT_MAX_PROPOSALS;
  const endpointModeRaw =
    process.env.ISSUE_SCOUT_LLM_ENDPOINT?.trim().toLowerCase() || DEFAULT_ENDPOINT_MODE;
  const endpointMode = ["auto", "chat", "completions", "responses"].includes(endpointModeRaw)
    ? endpointModeRaw
    : DEFAULT_ENDPOINT_MODE;
  return { apiKey, baseUrl, model, maxProposals, endpointMode };
}

function writeEmpty(reason) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = { issues: [], skipped: reason };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log(`wrote ${OUTPUT_PATH} (${reason})`);
}

function extractTextFromOpenAI(payload) {
  const direct = payload?.choices?.[0]?.message?.content;
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }
  if (Array.isArray(direct)) {
    const joined = direct
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
    if (joined) {
      return joined;
    }
  }
  const outputText = payload?.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText;
  }
  const responseOutputText = Array.isArray(payload?.output)
    ? payload.output
        .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
        .map((part) =>
          part?.type === "output_text" && typeof part?.text === "string" ? part.text : "",
        )
        .join("\n")
        .trim()
    : "";
  if (responseOutputText) {
    return responseOutputText;
  }
  const completionText = payload?.choices?.[0]?.text;
  if (typeof completionText === "string" && completionText.trim()) {
    return completionText;
  }
  return "";
}

async function callChatCompletions(params) {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: params.prompt },
        { role: "user", content: JSON.stringify(params.snapshot) },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM chat request failed (${response.status}): ${body}`);
  }
  const payload = await response.json();
  const text = extractTextFromOpenAI(payload);
  if (!text) {
    throw new Error("LLM chat response did not contain any text content.");
  }
  return text;
}

async function callLegacyCompletions(params) {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0.2,
      prompt: `${params.prompt}\n\nRepository snapshot JSON:\n${JSON.stringify(params.snapshot)}`,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM completions request failed (${response.status}): ${body}`);
  }
  const payload = await response.json();
  const text = extractTextFromOpenAI(payload);
  if (!text) {
    throw new Error("LLM completions response did not contain any text content.");
  }
  return text;
}

async function callResponses(params) {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/responses`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0.2,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: params.prompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: JSON.stringify(params.snapshot) }],
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM responses request failed (${response.status}): ${body}`);
  }
  const payload = await response.json();
  const text = extractTextFromOpenAI(payload);
  if (!text) {
    throw new Error("LLM responses output did not contain any text content.");
  }
  return text;
}

function isLegacyCompletionsModel(model) {
  const normalized = model.toLowerCase();
  return (
    normalized.includes("gpt-3.5-turbo-instruct") ||
    normalized.startsWith("text-") ||
    normalized.includes("davinci")
  );
}

function isCodexLikeModel(model) {
  return model.toLowerCase().includes("codex");
}

function resolveTransportOrder(endpointMode, model) {
  if (endpointMode === "chat") {
    return ["chat", "responses", "completions"];
  }
  if (endpointMode === "completions") {
    return ["completions", "responses", "chat"];
  }
  if (endpointMode === "responses") {
    return ["responses", "chat", "completions"];
  }
  if (isCodexLikeModel(model)) {
    return ["responses", "chat", "completions"];
  }
  if (isLegacyCompletionsModel(model)) {
    return ["completions", "chat", "responses"];
  }
  return ["chat", "responses", "completions"];
}

function extractJsonBlock(text) {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1];
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text;
}

function sanitizeIssue(entry, index) {
  const title = typeof entry?.title === "string" ? entry.title.trim() : "";
  const body = typeof entry?.body === "string" ? entry.body.trim() : "";
  const dedupeKeyRaw = typeof entry?.dedupe_key === "string" ? entry.dedupe_key.trim() : "";
  const dedupeKey = dedupeKeyRaw
    ? dedupeKeyRaw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    : `issue-${index + 1}`;

  const labels = Array.isArray(entry?.labels)
    ? entry.labels
        .filter((label) => typeof label === "string")
        .map((label) => label.trim().toLowerCase())
        .filter((label) => label && ALLOWED_LABELS.has(label))
    : [];

  if (!title || !body) {
    return null;
  }

  return {
    title,
    body,
    labels: labels.length > 0 ? labels : ["enhancement"],
    dedupe_key: dedupeKey || `issue-${index + 1}`,
  };
}

async function main() {
  const { apiKey, baseUrl, model, maxProposals, endpointMode } = resolveEnv();
  if (!apiKey) {
    writeEmpty("missing ISSUE_SCOUT_LLM_API_KEY");
    return;
  }

  const snapshotRaw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
  const snapshot = JSON.parse(snapshotRaw);
  const prompt = fs.readFileSync(PROMPT_PATH, "utf8");

  if (endpointMode === "completions" && !isLegacyCompletionsModel(model)) {
    // eslint-disable-next-line no-console
    console.warn(
      `issue-scout: ISSUE_SCOUT_LLM_ENDPOINT=completions is legacy for model "${model}". Falling back to responses/chat on failure.`,
    );
  }

  const transportOrder = resolveTransportOrder(endpointMode, model);
  const failures = [];
  let text = "";

  for (const transport of transportOrder) {
    try {
      if (transport === "chat") {
        text = await callChatCompletions({ apiKey, baseUrl, model, prompt, snapshot });
      } else if (transport === "responses") {
        text = await callResponses({ apiKey, baseUrl, model, prompt, snapshot });
      } else {
        text = await callLegacyCompletions({ apiKey, baseUrl, model, prompt, snapshot });
      }
      if (text) {
        if (failures.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(`issue-scout: succeeded via ${transport} after fallback`);
        }
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${transport}: ${message}`);
    }
  }

  if (!text) {
    throw new Error(`All LLM endpoint attempts failed:\n${failures.join("\n")}`);
  }

  const jsonText = extractJsonBlock(text);
  const parsed = JSON.parse(jsonText);
  const rawIssues = Array.isArray(parsed?.issues) ? parsed.issues : [];

  const issues = rawIssues
    .map((entry, index) => sanitizeIssue(entry, index))
    .filter((entry) => entry !== null)
    .slice(0, maxProposals);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify({ issues }, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log(`wrote ${OUTPUT_PATH} (${issues.length} proposal(s))`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
