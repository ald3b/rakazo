import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

describe("mobile avatar style cache", () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it("falls back to the default style when clearing cannot delete the stored one", async () => {
    const SecureStore = await import("expo-secure-store");
    const { AVATAR_STYLE_KEY, clearAvatarStyle, loadAvatarStyle, saveAvatarStyle } = await import(
      "./avatar-style"
    );
    await saveAvatarStyle("organic");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error("locked"));

    await clearAvatarStyle();

    expect(store.get(AVATAR_STYLE_KEY)).toBe("robot");
    await expect(loadAvatarStyle()).resolves.toBe("robot");
  });

  it("defaults to robot and ignores an unknown stored value", async () => {
    const { AVATAR_STYLE_KEY, getCachedAvatarStyle, loadAvatarStyle } = await import(
      "./avatar-style"
    );
    expect(getCachedAvatarStyle()).toBe("robot");
    store.set(AVATAR_STYLE_KEY, "pixel");
    await expect(loadAvatarStyle()).resolves.toBe("robot");
  });

  it("starts from the last confirmed style on the next launch", async () => {
    const first = await import("./avatar-style");
    await first.saveAvatarStyle("organic");
    expect(store.get(first.AVATAR_STYLE_KEY)).toBe("organic");

    vi.resetModules();
    const next = await import("./avatar-style");
    expect(next.getCachedAvatarStyle()).toBe("robot");
    await expect(next.loadAvatarStyle()).resolves.toBe("organic");
    expect(next.getCachedAvatarStyle()).toBe("organic");
  });

  it("keeps the default when SecureStore cannot be read", async () => {
    const SecureStore = await import("expo-secure-store");
    const { loadAvatarStyle } = await import("./avatar-style");
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await expect(loadAvatarStyle()).resolves.toBe("robot");
  });

  it("retries a style whose save failed", async () => {
    const SecureStore = await import("expo-secure-store");
    const { AVATAR_STYLE_KEY, getCachedAvatarStyle, saveAvatarStyle } = await import(
      "./avatar-style"
    );
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await saveAvatarStyle("organic");
    expect(store.has(AVATAR_STYLE_KEY)).toBe(false);
    expect(getCachedAvatarStyle()).toBe("organic");

    await saveAvatarStyle("organic");
    expect(store.get(AVATAR_STYLE_KEY)).toBe("organic");
  });

  it("clears the cached style", async () => {
    const { AVATAR_STYLE_KEY, clearAvatarStyle, getCachedAvatarStyle, saveAvatarStyle } =
      await import("./avatar-style");
    await saveAvatarStyle("organic");
    await clearAvatarStyle();
    expect(store.has(AVATAR_STYLE_KEY)).toBe(false);
    expect(getCachedAvatarStyle()).toBe("robot");
  });

  it("discards a late save that finishes after clear", async () => {
    const SecureStore = await import("expo-secure-store");
    const { AVATAR_STYLE_KEY, clearAvatarStyle, getCachedAvatarStyle, saveAvatarStyle } =
      await import("./avatar-style");

    let finishSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      await gate;
      store.set(key, value);
    });

    const save = saveAvatarStyle("organic");
    await clearAvatarStyle();
    finishSave();
    await save;

    expect(store.has(AVATAR_STYLE_KEY)).toBe(false);
    expect(getCachedAvatarStyle()).toBe("robot");
  });

});
