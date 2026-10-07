// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const contrast = vi.hoisted(() => ({
  changed: undefined as ((enabled: boolean) => void) | undefined,
  resolved: "dark" as "dark" | "light",
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    addEventListener: (_event: string, handler: (enabled: boolean) => void) => {
      contrast.changed = handler;
      return { remove: () => undefined };
    },
    isDarkerSystemColorsEnabled: () => Promise.resolve(false),
  },
  Platform: { OS: "ios" },
  PlatformColor: (name: string) => `platform:${name}`,
}));

vi.mock("./appearance", () => ({
  getCachedAppearancePreference: () => "system",
  mobileTokens: () => ({ card: "token-card" }),
  resolveMobileAppearance: () => contrast.resolved,
  subscribeAppearance: () => () => undefined,
}));

import { native, useThemedStyles } from "./native";

let seen: unknown;

function Probe() {
  seen = useThemedStyles(() => native.groupedCell);
  return null;
}

describe("grouped cells with Increase Contrast", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    contrast.resolved = "dark";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      contrast.changed?.(false);
      root?.unmount();
    });
    container?.remove();
  });

  it("switches dark cells to the card token while darker system colours are on", async () => {
    await act(async () => {
      root?.render(<Probe />);
    });
    expect(seen).toBe("platform:secondarySystemGroupedBackground");

    act(() => contrast.changed?.(true));
    expect(seen).toBe("token-card");

    act(() => contrast.changed?.(false));
    expect(seen).toBe("platform:secondarySystemGroupedBackground");
  });

  it("keeps the system cell in light", async () => {
    contrast.resolved = "light";
    await act(async () => {
      root?.render(<Probe />);
    });

    act(() => contrast.changed?.(true));
    expect(seen).toBe("platform:secondarySystemGroupedBackground");
  });
});
