import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

test("marks a website login as not a password in settings, and its next card starts with it on", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `not-a-password-${stamp}@rakazo.test`, "password12", "Not A Password");
  await completeOnboarding(page);
  const botName = `Sign-in ${stamp}`;
  const botId = await createNamedBot(page, botName);
  const username = `fake-user-${stamp}@example.test`;
  const secondValue = `fake-second-value-${stamp}`;

  // Settings: a website login whose second value is marked as not a password.
  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  const credentials = settings.getByTestId("bot-credentials");
  await credentials.getByTestId("credential-add").click();
  const addForm = credentials.getByTestId("credential-add-form");
  // The name and site the scripted "show a login card" asks for.
  await addForm.getByTestId("credential-name").fill("example_login");
  await addForm.getByTestId("credential-origin").fill("https://login.example.test");
  await addForm.getByTestId("credential-auth-type").selectOption("login");
  await addForm.getByTestId("credential-username").fill(username);
  await addForm.getByTestId("credential-value").fill(secondValue);
  const settingsSwitch = addForm.getByRole("switch", { name: "Not a password", exact: true });
  await expect(settingsSwitch).not.toBeChecked();
  await settingsSwitch.click();
  await expect(settingsSwitch).toBeChecked();
  await captureScreenshot(page, testInfo, "login-not-a-password-settings");
  await addForm.getByTestId("credential-add-save").click();
  await expect(credentials.getByTestId("bot-credential-row")).toHaveCount(1);
  const listed = await rpc<Array<Record<string, unknown>>>(page, "botSecrets/list", { botId });
  expect(listed).toEqual([expect.objectContaining({ name: "example_login", secondValue: "text" })]);
  expect(JSON.stringify(listed)).not.toContain(secondValue);

  // The card that replaces it starts with the switch on.
  await page.goto(`/app/${botId}`);
  await page.getByPlaceholder(`Message ${botName}`).fill("replace the login card");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  const card = page.getByTestId("secret-ask-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(`Message ${botName}`)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  const cardSwitch = card.getByRole("switch", { name: "Not a password", exact: true });
  await expect(cardSwitch).toBeChecked();
  await captureScreenshot(page, testInfo, "login-not-a-password-card");

  await card.getByLabel("Username").fill(username);
  // Exact: the password reveal button is labelled "Show password".
  await card.getByLabel("Password", { exact: true }).fill(secondValue);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 });
  const history = JSON.stringify(await rpc(page, "threads/messages", { botId }));
  expect(history).not.toContain(secondValue);
  expect(await rpc<Array<Record<string, unknown>>>(page, "botSecrets/list", { botId })).toEqual([
    expect.objectContaining({ name: "example_login", secondValue: "text" }),
  ]);
});
