import type { Routine } from "@rakazo/contracts";
import { formatCron } from "@rakazo/core";
import { t } from "./i18n";

/** One line of state and triggers for the routine screen, with the schedule's time zone. */
export function routineStatusLine(routine: Routine): string {
  return [
    routine.active ? t("Active") : t("Paused"),
    [
      ...routine.crons.map(formatCron),
      ...(routine.webhookEnabled ? [t("Webhook")] : []),
      ...(routine.githubEnabled ? [t("Git event")] : []),
      ...(routine.messageProvider === "slack"
        ? [t("Slack message")]
        : routine.messageProvider === "teams"
          ? [t("Teams message")]
          : routine.messageProvider
            ? [t("Message event")]
            : []),
    ].join(", "),
    routine.timezone,
  ].join(" · ");
}
