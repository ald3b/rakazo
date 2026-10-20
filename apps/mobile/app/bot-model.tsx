import type { ChatModelChoice } from "@rakazo/core";
import { filterModelChoices } from "@rakazo/core";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Checkmark } from "../components/row-accessories";
import { SettingsRow } from "../components/settings-group";
import type { MobileMe, MobileModel, MobileModelCredential } from "../lib/api";
import { rpc } from "../lib/api";
import { chatModelPickerChoices } from "../lib/chat-model";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";

/** A chat's model, from a list too long for a menu, with the system search field. */
export default function BotModelScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const navigation = useNavigation();
  const styles = useThemedStyles(createStyles);
  const { botId, value = "" } = useLocalSearchParams<{ botId: string; value?: string }>();
  const [choices, setChoices] = useState<ChatModelChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void Promise.all([
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ])
      .then(([me, catalog, credentials]) =>
        setChoices(chatModelPickerChoices(me, catalog, credentials, value, t)),
      )
      .catch((err) => setError(errorText(err, t("Could not load model settings"))));
  }, [t, value]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t("Search"),
        hideWhenScrolling: false,
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        onClose: () => setQuery(""),
      },
    });
  }, [navigation, t]);

  const matched = useMemo(
    () => (choices ? filterModelChoices(choices, query) : []),
    [choices, query],
  );
  const noMatches = choices !== null && matched.length === 0;

  // The search field keeps focus, so tell screen readers once when the results run out.
  useEffect(() => {
    if (noMatches) AccessibilityInfo.announceForAccessibility(t("No matching models"));
  }, [noMatches, t]);

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      data={matched}
      keyExtractor={(choice) => choice.key || "space-default"}
      ItemSeparatorComponent={() => (
        <View style={styles.cell}>
          <View style={styles.separator} />
        </View>
      )}
      ListEmptyComponent={
        error || noMatches ? (
          <Text style={styles.empty}>{error ?? t("No matching models")}</Text>
        ) : (
          <ActivityIndicator color={native.secondaryLabel} />
        )
      }
      renderItem={({ item, index }) => {
        const selected = item.key === value;
        return (
          <View
            style={[
              styles.cell,
              index === 0 && styles.first,
              index === matched.length - 1 && styles.last,
            ]}
          >
            <SettingsRow
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={{ selected }}
              onPress={() =>
                router.dismissTo({ pathname: "/bot-settings", params: { botId, model: item.key } })
              }
              title={item.label}
              trailing={selected ? <Checkmark /> : null}
            />
          </View>
        );
      }}
    />
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
    cell: { backgroundColor: native.groupedCell, overflow: "hidden" },
    first: { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderCurve: "continuous" },
    last: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16, borderCurve: "continuous" },
    separator: {
      height: StyleSheet.hairlineWidth,
      marginStart: 16,
      backgroundColor: native.separator,
    },
    empty: {
      color: native.secondaryLabel,
      fontSize: 15,
      paddingHorizontal: 16,
      paddingVertical: 10,
      textAlign: "center",
    },
  });
}
