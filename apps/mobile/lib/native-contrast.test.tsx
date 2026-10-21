import { beforeEach, describe, expect, it, vi } from "vitest";

const appearance = vi.hoisted(() => ({
  preference: "system" as "system" | "light" | "dark",
  resolved: "dark" as "dark" | "light",
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  PlatformColor: (name: string) => `platform:${name}`,
}));

vi.mock("./appearance", () => ({
  getCachedAppearancePreference: () => appearance.preference,
  mobileTokens: () => ({
    background: "token-background",
    border: "token-border",
    card: "token-card",
    faintForeground: "token-faint",
    muted: "token-muted",
  }),
  resolveMobileAppearance: () => appearance.resolved,
  subscribeAppearance: () => () => undefined,
}));

import { native } from "./native";

describe("grouped colours", () => {
  beforeEach(() => {
    appearance.preference = "system";
    appearance.resolved = "dark";
  });

  it("uses the token page and card in dark, so red text keeps 4.5:1 inside sheets", () => {
    expect(native.groupedPage).toBe("token-background");
    expect(native.groupedCell).toBe("token-card");

    appearance.preference = "dark";
    expect(native.groupedPage).toBe("token-background");
    expect(native.groupedCell).toBe("token-card");
  });

  it("uses the token page and card in light too, in System and forced Light", () => {
    appearance.resolved = "light";
    expect(native.groupedPage).toBe("token-background");
    expect(native.groupedCell).toBe("token-card");

    appearance.preference = "light";
    expect(native.groupedPage).toBe("token-background");
    expect(native.groupedCell).toBe("token-card");
  });
});

describe("text, fills and separators", () => {
  beforeEach(() => {
    appearance.preference = "system";
    appearance.resolved = "light";
  });

  it("divides rows with the palette divider in every mode", () => {
    expect(native.separator).toBe("token-border");
    appearance.preference = "dark";
    expect(native.separator).toBe("token-border");
  });

  it("falls back to faint text for tertiary labels and the muted fill for quiet chips", () => {
    expect(native.tertiaryLabel).toBe("platform:tertiaryLabel");
    expect(native.quietFill).toBe("platform:quaternarySystemFill");

    appearance.preference = "light";
    expect(native.tertiaryLabel).toBe("token-faint");
    expect(native.quietFill).toBe("token-muted");
  });
});
