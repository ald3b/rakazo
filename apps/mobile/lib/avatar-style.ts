import type { AvatarStyle } from "@rakazo/contracts";
import { AvatarStyleSchema } from "@rakazo/contracts";
import * as SecureStore from "expo-secure-store";

/** The last avatar style the server confirmed, so an offline launch starts from it. */
export const AVATAR_STYLE_KEY = "rakazo.avatar-style";

let memoryStyle: AvatarStyle | null = null;
/** What SecureStore holds, so a failed write is retried by the next save. */
let storedStyle: AvatarStyle | null = null;

export function getCachedAvatarStyle(): AvatarStyle {
  return memoryStyle ?? "robot";
}

export async function loadAvatarStyle(): Promise<AvatarStyle> {
  try {
    const stored = await SecureStore.getItemAsync(AVATAR_STYLE_KEY);
    memoryStyle = AvatarStyleSchema.safeParse(stored).data ?? null;
    storedStyle = memoryStyle;
  } catch {
    // Keep the default when SecureStore is unavailable.
  }
  return getCachedAvatarStyle();
}

export async function saveAvatarStyle(style: AvatarStyle): Promise<void> {
  memoryStyle = style;
  if (style === storedStyle) return;
  try {
    await SecureStore.setItemAsync(AVATAR_STYLE_KEY, style);
    storedStyle = style;
  } catch {
    // Keep the in-memory style when SecureStore is unavailable.
  }
}

export async function clearAvatarStyle(): Promise<void> {
  memoryStyle = null;
  storedStyle = null;
  try {
    await SecureStore.deleteItemAsync(AVATAR_STYLE_KEY);
  } catch {
    // If the key can't be removed, overwrite it so the next account doesn't start from this style.
    try {
      await SecureStore.setItemAsync(AVATAR_STYLE_KEY, "robot");
    } catch {
      // The server value replaces a stale style on the next fetch.
    }
  }
}
