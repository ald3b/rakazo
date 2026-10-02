import type { AvatarStyle, Me } from "@rakazo/contracts";
import { usePathname } from "expo-router";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { rpc } from "../lib/api";
import { getCachedAvatarStyle, saveAvatarStyle } from "../lib/avatar-style";

const AvatarStyleContext = createContext<{
  avatarStyle: AvatarStyle;
  updateAvatarStyle: (avatarStyle: AvatarStyle) => Promise<void>;
}>({
  avatarStyle: "robot",
  updateAvatarStyle: async () => undefined,
});

export function AvatarStyleProvider({ children }: { children: ReactNode }) {
  const [avatarStyle, setAvatarStyle] = useState<AvatarStyle>(getCachedAvatarStyle);
  const pathname = usePathname();
  const requestIdRef = useRef(0);
  const updatePromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    function refresh() {
      // The update's response is newer than a `me` that would supersede it.
      if (updatePromiseRef.current) return;
      const requestId = ++requestIdRef.current;
      void rpc<Me>("me")
        .then((me) => {
          if (requestId !== requestIdRef.current) return;
          setAvatarStyle(me.avatarStyle);
          void saveAvatarStyle(me.avatarStyle);
        })
        .catch(() => undefined);
    }
    refresh();
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => appState.remove();
  }, [pathname]);

  function updateAvatarStyle(next: AvatarStyle): Promise<void> {
    if (updatePromiseRef.current) return updatePromiseRef.current;
    const requestId = ++requestIdRef.current;
    const update = rpc<Me>("preferences/update", { avatarStyle: next })
      .then((me) => {
        if (requestId !== requestIdRef.current) return;
        setAvatarStyle(me.avatarStyle);
        void saveAvatarStyle(me.avatarStyle);
      })
      .finally(() => {
        updatePromiseRef.current = null;
      });
    updatePromiseRef.current = update;
    return update;
  }

  return (
    <AvatarStyleContext value={{ avatarStyle, updateAvatarStyle }}>{children}</AvatarStyleContext>
  );
}

export function useAvatarStyle() {
  return useContext(AvatarStyleContext);
}
