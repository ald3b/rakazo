import type { AvatarStyle } from "@rakazo/contracts";
import { AvatarStyleSchema } from "@rakazo/contracts";
import * as SecureStore from "expo-secure-store";

/** The last avatar style the server confirmed, so an offline launch starts from it. */
export const AVATAR_STYLE_KEY = "rakazo.avatar-style";

let memoryStyle: AvatarStyle | null = null;
/** What SecureStore holds, so a failed write is retried by the next save. */
let storedStyle: AvatarStyle | null = null;
let writeGeneration = 0;

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
  const generation = ++writeGeneration;
  await persistAvatarStyle(style, generation);
}

async function persistAvatarStyle(style: AvatarStyle, generation: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(AVATAR_STYLE_KEY, style);
  } catch {
    // Keep the in-memory style when SecureStore is unavailable; retry on the next save.
    return;
  }
  if (generation !== writeGeneration) {
    if (memoryStyle === null) {
      storedStyle = null;
      await clearStoredAvatarStyle();
      return;
    }
    await persistAvatarStyle(memoryStyle, writeGeneration);
    return;
  }
  storedStyle = style;
}

export async function clearAvatarStyle(): Promise<void> {
  writeGeneration += 1;
  memoryStyle = null;
  storedStyle = null;
  await clearStoredAvatarStyle();
}

async function clearStoredAvatarStyle(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(AVATAR_STYLE_KEY);
  } catch {
    try {
      await SecureStore.setItemAsync(AVATAR_STYLE_KEY, "robot");
      storedStyle = "robot";
    } catch {
      // SecureStore may be unavailable.
    }
  }
}
