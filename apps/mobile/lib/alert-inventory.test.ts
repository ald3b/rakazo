import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The argument text of each `Alert.alert(...)` call. */
function alertCalls(source: string): string[] {
  const calls: string[] = [];
  let at = source.indexOf("Alert.alert(");
  while (at >= 0) {
    let depth = 0;
    let end = at + "Alert.alert".length;
    do {
      const char = source[end];
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      end += 1;
    } while (depth > 0 && end < source.length);
    calls.push(source.slice(at, end));
    at = source.indexOf("Alert.alert(", end);
  }
  return calls;
}

// Screens can't all be rendered in unit tests, so this inventory guards the rule instead:
// notices are toasts, and a native alert always offers a choice.
describe("alerts", () => {
  it("keeps Alert.alert only for decisions", () => {
    const calls = ["app", "components", "lib"].flatMap((dir) =>
      sources(resolve(mobileRoot, dir)).flatMap((path) => alertCalls(readFileSync(path, "utf8"))),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call, call).toMatch(/\[\s*\{\s*text:|\bbuttons\b/);
  });
});
