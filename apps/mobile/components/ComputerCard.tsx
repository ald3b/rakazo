import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { MessageBlock } from "@rakazo/contracts";
import type { ViewProps } from "react-native";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";

export function ComputerCard({
  block,
  onOpen,
  accessibilityActions,
  onAccessibilityAction,
}: {
  block: Extract<MessageBlock, { kind: "computer" }>;
  onOpen: () => void;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  // Bot rows are content-sized, so a percentage width would shrink to the text.
  const { width: windowWidth } = useWindowDimensions();

  return (
    <View
      testID="computer-card"
      style={{
        width: Math.min(340, Math.round(windowWidth * 0.8)),
        borderRadius: 18,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={onAccessibilityAction}
          style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}
        >
          {t("Computer")}
        </Text>
        <Text
          style={{
            color: block.state === "Needs you" ? tokens.warning : tokens.success,
            flexShrink: 1,
            fontSize: 13,
          }}
        >
          {block.state}
        </Text>
      </View>
      {block.text ? (
        <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
          {block.text}
        </ChatMarkdown>
      ) : null}
      <Pressable
        testID="computer-card-open"
        accessibilityRole="button"
        onPress={onOpen}
        style={{
          alignSelf: "flex-start",
          minHeight: 36,
          paddingHorizontal: 14,
          borderRadius: 999,
          backgroundColor: native.fillPressed,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: native.label, fontSize: 14, fontWeight: "600" }}>
          {t("Open computer")}
        </Text>
      </Pressable>
    </View>
  );
}
