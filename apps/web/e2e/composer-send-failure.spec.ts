import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function openComposer(page: Page, prefix: string) {
  await signup(page, `${prefix}-${Date.now()}@rakazo.test`, "password12", "Draft Keeper");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await expect(composer).toBeVisible();
  return composer;
}

test("a failed send keeps the message and its attachment in the composer", async ({
  page,
}, testInfo) => {
  const composer = await openComposer(page, "send-failure");
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("meeting notes"),
  });
  const removeAttachment = page.getByRole("button", { name: "Remove notes.txt" });
  await expect(removeAttachment).toBeVisible();

  await page.route("**/rpc/threads/send", (route) => route.abort("internetdisconnected"));
  await composer.fill("message that fails to send");
  await composer.press("Enter");

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(composer).toHaveValue("message that fails to send");
  await expect(removeAttachment).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-send-failure-keeps-draft");

  await page.unroute("**/rpc/threads/send");
  await composer.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("message that fails to send", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(removeAttachment).toBeHidden();
  await expect(page.getByTestId("composer-error")).toBeHidden();
});

test("a failed send leaves a newer draft alone", async ({ page }) => {
  const composer = await openComposer(page, "send-failure-newer");
  let failSend = () => {};
  const sendFailed = new Promise<void>((resolve) => {
    failSend = resolve;
  });
  await page.route("**/rpc/threads/send", async (route) => {
    await sendFailed;
    await route.abort("internetdisconnected");
  });

  await composer.fill("first message");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await composer.fill("newer draft");
  failSend();

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(composer).toHaveValue("newer draft");
});

async function createRoutine(page: Page, name: string) {
  return rpc<Routine>(page, "routines/create", {
    botId: activeBotId(page),
    name,
    prompt: "Summarize today",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: false,
    notify: false,
  });
}

async function mentionRoutine(page: Page, composer: Locator, name: string) {
  await composer.fill(`@${name.slice(0, 4)}`);
  await expect(page.getByRole("option", { name: `@${name}` })).toBeVisible();
  await composer.press("Enter");
}

test("a routine that already ran is not put back when the thread refresh fails", async ({
  page,
}) => {
  const composer = await openComposer(page, "send-failure-routine");
  await createRoutine(page, "daily-digest");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  const chip = page.getByTestId("mention-chip");
  await expect(chip).toHaveText("daily-digest");

  const testRun = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/testRun") && response.ok(),
  );
  await page.route("**/rpc/threads/get", (route) => route.abort("internetdisconnected"));
  await composer.press("Enter");
  await testRun;

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(chip).toHaveCount(0);
  await expect(composer).toHaveValue("");
});

test("a message is not put back when one of its routines already ran", async ({ page }) => {
  const composer = await openComposer(page, "send-failure-routines");
  await createRoutine(page, "daily-digest");
  const failing = await createRoutine(page, "weekly-review");
  await page.reload();
  await mentionRoutine(page, composer, "daily-digest");
  await mentionRoutine(page, composer, "weekly-review");
  await expect(page.getByTestId("mention-chip")).toHaveCount(2);

  await page.route("**/rpc/routines/testRun", (route) => {
    const input = route.request().postDataJSON() as { json: { routineId: string } };
    return input.json.routineId === failing.id
      ? route.abort("internetdisconnected")
      : route.continue();
  });
  const accepted = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/testRun") && response.ok(),
  );
  await composer.fill("and the notes");
  await composer.press("Enter");
  await accepted;

  await expect(page.getByTestId("composer-error")).toBeVisible();
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  await expect(composer).toHaveValue("");
});
