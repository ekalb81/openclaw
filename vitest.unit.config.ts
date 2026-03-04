import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { include?: string[]; exclude?: string[] } }).test ?? {};
const include = (
  baseTest.include ?? ["src/**/*.test.ts", "extensions/**/*.test.ts", "test/format-error.test.ts"]
).filter((pattern) => !pattern.includes("extensions/"));
const exclude = baseTest.exclude ?? [];
const isCoverageRun = process.argv.includes("--coverage");
const scopedExcludes = [
  // Keep full gateway suites off the default fast unit lane.
  // Coverage runs include gateway tests to widen core runtime signal incrementally.
  ...(isCoverageRun ? [] : ["src/gateway/**"]),
  "extensions/**",
  "src/telegram/**",
  "src/discord/**",
  "src/web/**",
  "src/browser/**",
  "src/line/**",
  "src/agents/**",
  "src/auto-reply/**",
  "src/commands/**",
];

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include,
    exclude: [...exclude, ...scopedExcludes],
  },
});
