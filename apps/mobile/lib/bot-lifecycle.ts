import { Alert } from "react-native";
import { rpc } from "./api";
import { t } from "./i18n";
import { toast } from "./toast";
import { errorText } from "./user-error";

export function confirmDeleteBot(bot: { id: string; name: string }, onDeleted: () => void) {
  const remove = async (deleteMemories: boolean) => {
    try {
      await rpc("bots/remove", { botId: bot.id, deleteMemories });
      onDeleted();
    } catch (error) {
      toast.show(t("Could not delete bot"), {
        variant: "error",
        detail: errorText(error, t("Try again.")),
      });
    }
  };

  Alert.alert(
    t("Delete {name}?", { name: bot.name }),
    t(
      "Its conversation, files, and routines will be permanently deleted. What should happen to its memories?",
    ),
    [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Keep memories"), style: "destructive", onPress: () => void remove(false) },
      {
        text: t("Delete memories too"),
        style: "destructive",
        onPress: () => void remove(true),
      },
    ],
  );
}

export async function restoreArchivedBot(botId: string): Promise<void> {
  await rpc("bots/restore", { botId });
}
