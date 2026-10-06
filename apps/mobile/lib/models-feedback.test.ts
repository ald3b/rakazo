import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screen = readFileSync(resolve(mobileRoot, "app/models.tsx"), "utf8");

describe("Models save feedback", () => {
  it("shows results under the buttons that produced them and announces them", () => {
    const header = screen.slice(
      screen.indexOf('{t("Active model")}'),
      screen.indexOf('{t("Providers")}'),
    );
    expect(header).not.toContain("{error ?");
    expect(header).not.toContain("{notice ?");
    expect(screen).toMatch(
      /t\("Find models"\)\}<\/Text>\s*<\/Pressable>\s*\{probeFeedback \? feedback : null\}/,
    );
    expect(screen).toMatch(
      /\{compatKeySection\}\s*\{saveRow\}\s*\{probeFeedback \? null : feedback\}/,
    );
    expect(screen).toMatch(/\{catalogConnectionControls\}<\/View>\s*\{feedback\}/);
    expect(screen).toMatch(/\{catalogConnectionControls\}\s*\{feedback\}/);
    expect(screen).toContain("AccessibilityInfo.announceForAccessibility(message)");
  });

  it("clears the last result before rejecting a limit", () => {
    const connect = screen.slice(
      screen.indexOf("async function connectKey()"),
      screen.indexOf("async function finishSubscriptionSignIn"),
    );
    const cleared = connect.indexOf("setNotice(null)");
    expect(cleared).toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(connect.indexOf("parseModelMaxTokens("));
  });
});
