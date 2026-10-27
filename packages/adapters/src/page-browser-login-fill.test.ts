import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { resolveRequestSecretDestination } from "./bot-secrets.js";
import { NO_PASSWORD_FIELD_REFUSAL } from "./browser-tools.js";

/** The live page helper's isolated-world script, executed here rather than reimplemented. */
function installPageHelper(url: string, html: string) {
  const source = readFileSync(
    new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url),
    "utf8",
  );
  const match = source.match(/EVAL_HELPERS = r"""\n([\s\S]*?)\n"""/);
  if (!match?.[1]) throw new Error("page browser helper script was not found");
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Sign in</title></head><body>${html}</body></html>`,
    {
      url,
      pretendToBeVisual: true,
      runScripts: "outside-only",
    },
  );
  const domWindow = dom.window;
  const elementPrototype = domWindow.Element.prototype as unknown as {
    getBoundingClientRect: (this: Element) => unknown;
  };
  // jsdom has no layout: every element is a 10 px square unless data-rect="left,top,width,height".
  elementPrototype.getBoundingClientRect = function () {
    const [left = 0, top = 0, width = 10, height = 10] = (
      this.getAttribute("data-rect") ?? "0,0,10,10"
    )
      .split(",")
      .map(Number);
    return {
      width,
      height,
      top,
      left,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON() {
        return {};
      },
    };
  };
  // jsdom has no layout, so no innerText: page text is its text content here.
  if (!("innerText" in domWindow.HTMLElement.prototype)) {
    Object.defineProperty(domWindow.HTMLElement.prototype, "innerText", {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent;
      },
    });
  }
  vm.runInContext(match[1], dom.getInternalVMContext());
  const browser = (
    domWindow as unknown as {
      __rakazoPageBrowser: {
        snapshot: () => {
          elements: Array<{ ref: string; name: string; role: string; value?: string }>;
          tree: string;
        };
        fill: (
          ref: string,
          value: string,
          origin?: string,
          field?: string,
          secondValue?: "text",
          login?: string,
        ) => { url: string };
        focusForKeys: (ref: string, whole?: boolean) => { focused: boolean };
        focusHolds: () => boolean;
        typed: (ref: string, text: string) => boolean;
      };
    }
  ).__rakazoPageBrowser;
  return { domWindow, browser };
}

function fieldValue(window: JSDOM["window"], label: string): string {
  const field = window.document.querySelector(`[aria-label="${label}"]`) as {
    value?: string;
  } | null;
  return field?.value ?? "";
}

function refFor(name: string, elements: Array<{ ref: string; name: string }>) {
  const match = elements.find((element) => element.name.includes(name));
  if (!match) throw new Error(`missing field ${name}`);
  return match.ref;
}

describe("live page helper saved-login fill", () => {
  const html = `
    <input aria-label="Email" />
    <input aria-label="Password" type="password" />
    <input aria-label="Phone" type="tel" />
    <textarea aria-label="Username"></textarea>
    <input aria-label="Query" type="search" />
    <input aria-label="Website" type="url" />
    <input aria-label="Pin" type="number" />
  `;

  const origin = "https://login.example.test";

  it("types a username only into text, email, and tel inputs on the saved HTTPS origin", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const snap = browser.snapshot();
    browser.fill(refFor("Email", snap.elements), "fake-user", origin, "username");
    browser.fill(refFor("Phone", snap.elements), "555", origin, "username");
    expect(fieldValue(domWindow, "Email")).toBe("fake-user");
    expect(fieldValue(domWindow, "Phone")).toBe("555");
    for (const name of ["Password", "Username", "Query", "Website", "Pin"]) {
      expect(() =>
        browser.fill(refFor(name, snap.elements), "fake-name", origin, "username"),
      ).toThrow(/text, email, or telephone/);
    }
    expect(fieldValue(domWindow, "Password")).toBe("");
  });

  it("types a password only into a password field, also when the field is not named", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const snap = browser.snapshot();
    for (const name of ["Email", "Phone", "Username", "Query", "Website", "Pin"]) {
      for (const field of ["password", undefined]) {
        expect(() =>
          browser.fill(refFor(name, snap.elements), "fake-password", origin, field),
        ).toThrow(/password field/);
      }
    }
    expect(domWindow.document.body.innerHTML).not.toContain("fake-password");
    expect(JSON.stringify(browser.snapshot())).not.toContain("fake-password");
    browser.fill(
      refFor("Password", browser.snapshot().elements),
      "fake-password",
      origin,
      "password",
    );
    expect(fieldValue(domWindow, "Password")).toBe("fake-password");
    expect(JSON.stringify(browser.snapshot())).not.toContain("fake-password");
  });

  function passwordField(domWindow: JSDOM["window"]) {
    return domWindow.document.querySelector('[aria-label="Password"]') as HTMLInputElement;
  }

  it("preserves a revealed password while keeping its value out of snapshots", async () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const field = passwordField(domWindow);
    field.addEventListener("input", () => (field.type = "text"), { once: true });
    const ref = refFor("Password", browser.snapshot().elements);
    browser.fill(ref, "fake-password", origin, "password");
    await Promise.resolve();
    expect(field.type).toBe("text");
    expect(field.value).toBe("fake-password");
    // Snapshots still never report it.
    expect(JSON.stringify(browser.snapshot())).not.toContain("fake-password");
  });

  describe("a second value the person marked as not a password", () => {
    // A sign-in without a form, as single-page apps often have, next to other fields.
    const idPage = `
      <div><input aria-label="ID number" /><input aria-label="Phone" type="tel" /></div>
      <input aria-label="Email" type="email" />
      <input aria-label="Query" type="search" />
      <textarea aria-label="Notes"></textarea>
    `;
    const phoneField = (domWindow: JSDOM["window"], label = "Phone") =>
      domWindow.document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    type Browser = ReturnType<typeof installPageHelper>["browser"];
    const fillId = (browser: Browser, label = "ID number", login = "site_login") =>
      browser.fill(
        refFor(label, browser.snapshot().elements),
        "fake-id",
        origin,
        "username",
        undefined,
        login,
      );
    const marked = (
      browser: Browser,
      label = "Phone",
      value = "fake-phone-0501234",
      login = "site_login",
    ) =>
      browser.fill(
        refFor(label, browser.snapshot().elements),
        value,
        origin,
        "password",
        "text",
        login,
      );
    // The login's username goes first, as on a real sign-in: the second value follows it.
    const fillPhone = (browser: Browser, label = "Phone", value = "fake-phone-0501234") => {
      fillId(browser);
      return marked(browser, label, value);
    };
    const nextFrame = (domWindow: JSDOM["window"]) =>
      new Promise((resolve) => domWindow.requestAnimationFrame(resolve));

    it.each(["Phone", "Code"])(
      "holds it in a password field in place of the %s field, on a page without one",
      (label) => {
        // A text field in place of the telephone one works the same.
        const page = idPage.replace(
          'aria-label="Phone" type="tel"',
          `aria-label="${label}" type="${label === "Phone" ? "tel" : "text"}"`,
        );
        const { domWindow, browser } = installPageHelper(`${origin}/signin`, page);
        const field = phoneField(domWindow, label);
        const types: string[] = [];
        field.addEventListener("input", () => types.push(field.type));
        fillPhone(browser, label);
        // The browser draws dots and keeps a password field's text out of copying, the desktop's
        // selection and form history, whatever the page's listeners do.
        expect(field.type).toBe("password");
        expect(field.value).toBe("fake-phone-0501234");
        // It was a password field before the value was set.
        expect(types).toEqual(["password"]);
        expect(JSON.stringify(browser.snapshot())).not.toContain("fake-phone");
        // Only fills of this helper's own make the page "have" a password field: a later fill of
        // the same login still finds none.
        fillPhone(browser, label);
        expect(field.value).toBe("fake-phone-0501234");
      },
    );

    it("goes only into the form its own login's username was typed into, never a search field", () => {
      const page = `
        <form id="signin"><input aria-label="ID number" /><input aria-label="Phone" type="tel" /></form>
        <form id="comment"><input aria-label="Comment" /></form>
        <div role="search"><input aria-label="Find" /></div>
        <form action="/results"><input aria-label="Lookup" name="q" /><input aria-label="Area" /></form>
      `;
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, page);
      // Before its username is typed, nothing.
      expect(() => marked(browser)).toThrow(/form its username was typed into/);
      // Another login's username doesn't open the form for this one.
      fillId(browser, "ID number", "other_login");
      expect(() => marked(browser)).toThrow(/form its username was typed into/);
      fillId(browser);
      for (const label of ["Comment", "Find", "Lookup"]) {
        expect(() => marked(browser, label), label).toThrow(/form its username was typed into/);
      }
      // A search form is refused whole: with the username in its query box, another of its
      // fields would still send the value into a results address.
      fillId(browser, "Lookup");
      expect(() => marked(browser, "Area")).toThrow(/not into a search field/);
      expect(domWindow.document.body.innerHTML).not.toContain("fake-phone");
      fillId(browser);
      marked(browser);
      expect(phoneField(domWindow).value).toBe("fake-phone-0501234");
    });

    it("goes beside its username only while the field still holds it", () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      const idField = phoneField(domWindow, "ID number");
      const fillOver = (value: string, login?: string) =>
        browser.fill(
          refFor("ID number", browser.snapshot().elements),
          value,
          login ? origin : undefined,
          login ? "username" : undefined,
          undefined,
          login,
        );
      const notBeside = /form its username was typed into/;
      // Another saved login's username typed over it, even the same one.
      for (const value of ["fake-id-b", "fake-id"]) {
        fillId(browser);
        fillOver(value, "other_login");
        expect(() => marked(browser), value).toThrow(notBeside);
      }
      // An ordinary fill over it.
      fillId(browser);
      fillOver("someone-else");
      expect(() => marked(browser)).toThrow(notBeside);
      // The person typing over it.
      fillId(browser);
      idField.value = "typed-by-hand";
      idField.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
      expect(() => marked(browser)).toThrow(notBeside);
      expect(domWindow.document.body.innerHTML).not.toContain("fake-phone");
      expect(phoneField(domWindow).value).toBe("");
      // Its own username, filled again, is followed by its second value as before.
      fillId(browser);
      fillId(browser);
      marked(browser);
      expect(phoneField(domWindow).value).toBe("fake-phone-0501234");
    });

    it("never goes into a field or form labelled as a search", () => {
      const page = `
        <form id="a"><input aria-label="ID number" /><label for="b">Search</label><input id="b" type="tel" /></form>
        <form id="c"><input aria-label="Member ID" /><span id="d">Search the site</span><input name="lookup" aria-labelledby="d" type="tel" /></form>
        <form id="e"><input aria-label="Account" /><input aria-label="Mobile" type="tel" /><button>Search</button></form>
      `;
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, page);
      for (const [username, phone] of [
        ["ID number", "Search"],
        ["Member ID", "lookup"],
        ["Account", "Mobile"],
      ] as const) {
        fillId(browser, username);
        expect(() => marked(browser, phone), phone).toThrow(/not into a search field/);
      }
      expect(domWindow.document.body.innerHTML).not.toContain("fake-phone");
      for (const field of domWindow.document.querySelectorAll("input[type=tel]")) {
        expect((field as HTMLInputElement).value).toBe("");
      }
    });

    it("goes only into a small sign-in form or container, on the address the username went in", () => {
      const page = `
        <div id="signin"><input aria-label="ID number" /><input aria-label="Phone" type="tel" /></div>
        <footer><input aria-label="Feedback" /></footer>
        <form><input aria-label="Name" /><input aria-label="Email" /><input aria-label="Mobile" type="tel" /><textarea aria-label="Message"></textarea></form>
        <form><input aria-label="First" /><input aria-label="Last" /><input aria-label="Street" /><input aria-label="Cell" type="tel" /></form>
      `;
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, page);
      // A field elsewhere on the page, outside the container both would share.
      fillId(browser);
      expect(() => marked(browser, "Feedback")).toThrow(/form its username was typed into/);
      // A contact form, with a free-text box, and a long address form are no sign-in forms.
      for (const [username, phone] of [
        ["Name", "Mobile"],
        ["First", "Cell"],
      ] as const) {
        fillId(browser, username);
        expect(() => marked(browser, phone), phone).toThrow(/form its username was typed into/);
      }
      // After the page moves to another address, the username is typed again first, also when
      // only its query or fragment changed, as a single-page app's screens do.
      for (const address of ["/account/reviews", "/signin?step=feedback", "/signin#/feedback"]) {
        domWindow.history.pushState({}, "", "/signin");
        fillId(browser);
        domWindow.history.pushState({}, "", address);
        expect(() => marked(browser), address).toThrow(/form its username was typed into/);
      }
      domWindow.history.pushState({}, "", "/signin");
      marked(browser);
      expect(phoneField(domWindow).value).toBe("fake-phone-0501234");
    });

    it("counts a message box placed outside its form with form= as part of it", () => {
      const { browser } = installPageHelper(
        `${origin}/signin`,
        '<form id="contact"><input aria-label="ID number" /><input aria-label="Phone" type="tel" /></form><textarea form="contact" aria-label="Message"></textarea>',
      );
      fillId(browser);
      expect(() => marked(browser)).toThrow(/form its username was typed into/);
    });

    it("doesn't take a page's other box for part of a formless sign-in", () => {
      const { browser } = installPageHelper(
        `${origin}/signin`,
        '<div id="app"><main><input aria-label="ID number" /><input aria-label="Phone" type="tel" /></main><footer><input aria-label="Feedback" /></footer></div>',
      );
      fillId(browser);
      expect(() => marked(browser, "Feedback")).toThrow(/form its username was typed into/);
      marked(browser);
    });

    it("doesn't take a re-rendered form for the same one without a name to tell", () => {
      const { domWindow, browser } = installPageHelper(
        `${origin}/signin`,
        '<form><input aria-label="ID number" /></form>',
      );
      fillId(browser);
      domWindow.document.body.innerHTML =
        '<form><input aria-label="Rating" /><input aria-label="Phone" type="tel" /></form>';
      expect(() => marked(browser)).toThrow(/form its username was typed into/);
    });

    it("keeps an unmarked password out of a field it made a password field, and leaves it as it was", () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      fillPhone(browser);
      const field = phoneField(domWindow);
      // Another login's real password, into the same field: judged by the field's own type.
      expect(() =>
        browser.fill(
          refFor("Phone", browser.snapshot().elements),
          "real-Passw0rd!",
          origin,
          "password",
          undefined,
          "other_login",
        ),
      ).toThrow(`Refused: ${NO_PASSWORD_FIELD_REFUSAL}`);
      // Refused, it changes nothing: the marked value stays, held as before.
      expect(field.type).toBe("password");
      expect(field.value).toBe("fake-phone-0501234");
    });

    it("starts no selection in the field it holds, by mouse or keyboard", () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      fillPhone(browser);
      const field = phoneField(domWindow);
      const dispatch = (event: Event) => {
        field.dispatchEvent(event);
        return event.defaultPrevented;
      };
      for (const detail of [1, 2, 3]) {
        expect(
          dispatch(new domWindow.MouseEvent("mousedown", { button: 0, detail, cancelable: true })),
        ).toBe(true);
        expect([field.selectionStart, field.selectionEnd]).toEqual([18, 18]);
      }
      expect(dispatch(new domWindow.MouseEvent("mousedown", { button: 1, cancelable: true }))).toBe(
        false,
      );
      for (const key of [
        { key: "ש", code: "KeyA", ctrlKey: true },
        { key: "ф", code: "KeyA", metaKey: true },
        { key: "End", code: "End", shiftKey: true },
      ]) {
        expect(
          dispatch(new domWindow.KeyboardEvent("keydown", { ...key, cancelable: true })),
          key.key,
        ).toBe(true);
      }
      expect(
        dispatch(new domWindow.KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true })),
      ).toBe(false);
      for (const type of ["selectstart", "contextmenu"]) {
        expect(dispatch(new domWindow.Event(type, { bubbles: true, cancelable: true })), type).toBe(
          true,
        );
      }
      field.select();
      field.dispatchEvent(new domWindow.Event("select", { bubbles: true }));
      expect([field.selectionStart, field.selectionEnd]).toEqual([18, 18]);
      // Keyboard focus would select it all, so Tab skips it; undo can't bring the value back.
      expect(field.getAttribute("tabindex")).toBe("-1");
      const undo = new domWindow.InputEvent("beforeinput", {
        inputType: "historyUndo",
        cancelable: true,
      });
      field.dispatchEvent(undo);
      expect(undo.defaultPrevented).toBe(true);
      // Filled with something else, it is the page's again.
      browser.fill(refFor("Phone", browser.snapshot().elements), "0501234567");
      expect(field.hasAttribute("tabindex")).toBe(false);
    });

    it("starts no selection again once the page puts the value back into the emptied field", async () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      fillPhone(browser, "Phone", "0501234567");
      const field = phoneField(domWindow);
      const starts = () => {
        const press = new domWindow.MouseEvent("mousedown", { button: 0, cancelable: true });
        field.dispatchEvent(press);
        const start = new domWindow.Event("selectstart", { bubbles: true, cancelable: true });
        field.dispatchEvent(start);
        return !press.defaultPrevented && !start.defaultPrevented;
      };
      const input = () => field.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
      // A phone widget empties the field, then the person types their own text: theirs to select.
      field.value = "";
      input();
      field.value = "my own text";
      input();
      expect(starts()).toBe(true);
      expect(field.hasAttribute("tabindex")).toBe(false);
      // The widget puts the number back, reformatted, with an input event or without one.
      field.value = "050-123-4567";
      input();
      expect(starts()).toBe(false);
      expect(field.getAttribute("tabindex")).toBe("-1");
      field.value = "";
      input();
      expect(field.hasAttribute("tabindex")).toBe(false);
      field.value = "0501234567";
      await nextFrame(domWindow);
      expect(starts()).toBe(false);
      expect(field.getAttribute("tabindex")).toBe("-1");
      field.select();
      field.dispatchEvent(new domWindow.Event("select", { bubbles: true }));
      expect([field.selectionStart, field.selectionEnd]).toEqual([10, 10]);
    });

    it("hides a number saved internationally where the page shows it nationally, within bounds", () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      fillPhone(browser, "Phone", "+972501234567");
      const echo = domWindow.document.createElement("p");
      echo.textContent = "Sent to 050\u2011123\u20114567, ref 000000.";
      domWindow.document.body.append(echo);
      const shown = JSON.stringify(browser.snapshot());
      expect(shown).not.toMatch(/123.{0,3}4567/);
      expect(shown).toContain("ref 000000");
      // A run of zeros, or a value too long to be a number, is matched only as it is.
      const zeros = installPageHelper(`${origin}/signin`, idPage);
      fillPhone(zeros.browser, "Phone", "000000");
      const text = zeros.domWindow.document.createElement("p");
      text.textContent = "Order 4567, page 2";
      zeros.domWindow.document.body.append(text);
      expect(JSON.stringify(zeros.browser.snapshot())).toContain("Order 4567, page 2");
      // Six or seven digits are matched only with spaces or dashes between.
      const short = installPageHelper(`${origin}/signin`, idPage);
      fillPhone(short.browser, "Phone", "123456");
      const note = short.domWindow.document.createElement("p");
      note.textContent = "Code 123-456. Version 1.2.3.4.5.6, date 12/34/56.";
      short.domWindow.document.body.append(note);
      expect(JSON.stringify(short.browser.snapshot())).toContain(
        "Code [redacted]. Version 1.2.3.4.5.6, date 12/34/56.",
      );
    });

    it("follows a sign-in form the page re-renders after the username", () => {
      const page = '<form id="signin" action="/signin"><input aria-label="ID number" /></form>';
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, page);
      fillId(browser);
      domWindow.document.body.innerHTML =
        '<form id="signin" action="/signin"><input aria-label="ID number" /><input aria-label="Phone" type="tel" /></form>';
      marked(browser);
      expect(phoneField(domWindow).value).toBe("fake-phone-0501234");
    });

    it("hides a phone number the page shows reformatted, in fields and text", async () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      fillPhone(browser, "Phone", "0501234567");
      // A phone widget that re-renders the field reformatted, unmasked, and echoes the number.
      phoneField(domWindow).outerHTML =
        '<input aria-label="Phone" type="tel" value="050-123-4567">';
      const echo = domWindow.document.createElement("p");
      echo.textContent = "We sent a code to +972 50-123 4567.";
      domWindow.document.body.append(echo);
      const shown = JSON.stringify(browser.snapshot());
      expect(shown).not.toMatch(/123.?4567/);
      expect(shown).toContain("We sent a code to +972 [redacted].");
      // So does every page-browser result, which carries the same snapshot.
      expect(JSON.stringify(browser.snapshot().tree)).not.toMatch(/4567/);
      // Also in the page's title and address, beside the tree, URL-encoded or not.
      domWindow.document.title = "Code sent to 050-123-4567";
      domWindow.history.pushState({}, "", "/sent?to=%2B972%2050%20123%204567&id=fake-id");
      const result = browser.snapshot() as unknown as { url: string; title: string };
      expect(result.title).toBe("Code sent to 0[redacted]");
      expect(result.url).toBe(`${origin}/sent?to=%2B972%20[redacted]&id=fake-id`);
      // Encoded Unicode dashes too: 050\u2011123\u20114567.
      domWindow.history.pushState({}, "", "/sent?to=050%E2%80%91123%E2%80%914567&id=fake-id");
      expect((browser.snapshot() as unknown as { url: string }).url).toBe(
        `${origin}/sent?to=0[redacted]&id=fake-id`,
      );
      // Other numbers stay readable.
      echo.textContent = "Order 4471";
      expect(JSON.stringify(browser.snapshot())).toContain("Order 4471");
    });

    it("passes over page text that stops one digit short quickly, whatever its separators", () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      fillPhone(browser, "Phone", "98765432101234567890");
      for (const gap of ["%20%20%20", "%2F%2F%2F%2F", " - "]) {
        const nearMiss = `${"9876543210123456789".split("").join(gap)}x`;
        domWindow.document.title = nearMiss;
        const started = performance.now();
        const { title } = browser.snapshot() as unknown as { title: string };
        expect(nearMiss.startsWith(title), gap).toBe(true);
        expect(performance.now() - started, gap).toBeLessThan(100);
      }
    });

    it("empties it when the page shows it as text, reformatted or not", async () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      const field = phoneField(domWindow);
      const events: string[] = [];
      field.addEventListener("input", () => events.push(field.value));
      fillPhone(browser, "Phone", "0501234567");
      // The page reformats it, then turns the field back into a telephone field.
      field.value = "050-123-4567";
      field.type = "tel";
      await Promise.resolve();
      expect(field.value).toBe("");
      expect(events).toEqual(["0501234567", ""]);
      // A page's own input events don't count as the person's edit: it still holds the login.
      fillPhone(browser, "Phone", "0501234567");
      field.value = "+972 50 123 4567";
      field.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
      field.type = "text";
      await nextFrame(domWindow);
      expect(field.value).toBe("");
    });

    it("leaves a field the page turned back into text to whoever types next", async () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      const field = phoneField(domWindow);
      fillPhone(browser, "Phone", "0501234567");
      field.type = "tel";
      await Promise.resolve();
      expect(field.value).toBe("");
      const emptied: string[] = [];
      field.addEventListener("input", () => emptied.push(field.value));
      // Someone taking over types into the cleared field: it stays, with no more events.
      field.value = "my own text";
      await nextFrame(domWindow);
      await nextFrame(domWindow);
      expect(field.value).toBe("my own text");
      expect(emptied).toEqual([]);
      // The page putting the login back, reformatted, is still emptied.
      field.value = "050-123-4567";
      await nextFrame(domWindow);
      expect(field.value).toBe("");
    });

    it("lets go of a field the page removes, emptied and with its own type", async () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      const field = phoneField(domWindow);
      fillPhone(browser);
      expect(field.type).toBe("password");
      field.remove();
      await nextFrame(domWindow);
      await nextFrame(domWindow);
      expect(field.value).toBe("");
      expect(field.getAttribute("type")).toBe("tel");
      // Nothing watches it any more: put back and given a value, it keeps it.
      domWindow.document.body.append(field);
      field.value = "typed later";
      await nextFrame(domWindow);
      expect(field.value).toBe("typed later");
    });

    it("reports a field the page replaced as the value went in as uncertain, not cleared", () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      fillId(browser);
      const field = phoneField(domWindow);
      field.addEventListener("input", () => field.replaceWith(field.cloneNode()), { once: true });
      expect(() => marked(browser)).toThrow(
        /^The page replaced this field as the login was typed\./,
      );
    });

    it("gives the field back its own type when it is typed over or refused", () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      const field = phoneField(domWindow);
      fillPhone(browser);
      // An SPA reusing the input for the code step: typing into it empties it and unmasks it.
      browser.focusForKeys(refFor("Phone", browser.snapshot().elements), false);
      expect(field.value).toBe("");
      expect(field.type).toBe("tel");
      // A field that only partly accepts the value is emptied and given back too.
      fillId(browser);
      field.maxLength = 4;
      Object.defineProperty(field, "value", {
        configurable: true,
        get: () => "trunc",
        set: () => undefined,
      });
      expect(() => marked(browser)).toThrow(/didn't accept the saved login/);
      expect(field.getAttribute("type")).toBe("tel");
    });

    it("refuses other fields, and a page that has a password field of its own", () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      for (const label of ["Email", "Query", "Notes"]) {
        expect(() => fillPhone(browser, label)).toThrow(
          /text or telephone field on a page without one/,
        );
      }
      // A real password belongs in the page's password field, also inside an open shadow root.
      const host = domWindow.document.createElement("div");
      host.attachShadow({ mode: "open" }).innerHTML = '<input type="password" />';
      domWindow.document.body.append(host);
      expect(() => fillPhone(browser)).toThrow(/on a page without one/);
      host.remove();
      domWindow.document.body.insertAdjacentHTML("beforeend", '<input type="password" />');
      expect(() => fillPhone(browser)).toThrow(/on a page without one/);
      expect(domWindow.document.body.innerHTML).not.toContain("fake-phone");
      expect(phoneField(domWindow).value).toBe("");
    });

    it("tells the bot how to ask for an unmarked password a page has nowhere to put", () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      const ref = refFor("Phone", browser.snapshot().elements);
      expect(() => browser.fill(ref, "fake-phone-0501234", origin, "password")).toThrow(
        `Refused: ${NO_PASSWORD_FIELD_REFUSAL}`,
      );
      expect(phoneField(domWindow).value).toBe("");
      // With a password field on the page, the usual refusal.
      domWindow.document.body.insertAdjacentHTML("beforeend", '<input type="password" />');
      expect(() => browser.fill(ref, "fake-phone-0501234", origin, "password")).toThrow(
        "Refused: A saved password can only be typed into a password field.",
      );
    });

    it("gives the field back its own type when it is filled again with something else", async () => {
      const { domWindow, browser } = installPageHelper(`${origin}/signin`, idPage);
      const field = phoneField(domWindow);
      fillPhone(browser);
      browser.fill(refFor("Phone", browser.snapshot().elements), "0501234567");
      await nextFrame(domWindow);
      expect(field.value).toBe("0501234567");
      expect(field.type).toBe("tel");
    });
  });

  it("refuses a password field that the page turns into text when it is focused", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const field = passwordField(domWindow);
    field.addEventListener("focus", () => (field.type = "text"));
    const ref = refFor("Password", browser.snapshot().elements);
    expect(() => browser.fill(ref, "fake-password", origin, "password")).toThrow(/password field/);
    expect(field.value).toBe("");
  });

  it("leaves nothing of a login that the field only partly accepts", () => {
    const { domWindow, browser } = installPageHelper(
      `${origin}/signin`,
      '<input aria-label="Email" type="email" />',
    );
    const ref = refFor("Email", browser.snapshot().elements);
    // Email fields trim surrounding spaces, so the value read back differs from the one set.
    // Settled like the other refusals: no desktop fallback, which can't type a saved login.
    expect(() => browser.fill(ref, " fake-user ", origin, "username")).toThrow(
      /^Refused: This field didn't accept the saved login, so it was cleared\.$/,
    );
    expect(fieldValue(domWindow, "Email")).toBe("");
  });

  it("fills a login saved from a page URL only on that page's exact site", () => {
    const origin = resolveRequestSecretDestination({
      label: "Sign in",
      purpose: "password",
      credential: {
        name: "site_login",
        origin: "https://www.example.test/some/login/page?x=1",
        auth: { type: "login" },
      },
    }).destination?.origin;
    expect(origin).toBe("https://www.example.test");
    const other = installPageHelper("https://www.example.test/other", html);
    other.browser.fill(
      refFor("Email", other.browser.snapshot().elements),
      "fake-user",
      origin,
      "username",
    );
    expect(fieldValue(other.domWindow, "Email")).toBe("fake-user");
    for (const url of ["https://example.test/login", "https://www.example.test.evil.test/login"]) {
      const { domWindow, browser } = installPageHelper(url, html);
      const email = refFor("Email", browser.snapshot().elements);
      expect(() => browser.fill(email, "fake-user", origin, "username")).toThrow(/not on the site/);
      expect(fieldValue(domWindow, "Email")).toBe("");
    }
  });

  it("refuses a private-LAN HTTP origin in the same fill, even when the page matches", () => {
    const origin = "http://192.168.2.10:8080";
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const email = refFor("Email", browser.snapshot().elements);
    expect(() => browser.fill(email, "fake-user", origin)).toThrow(/HTTPS/);
    expect(fieldValue(domWindow, "Email")).toBe("");
  });
});

describe("live page helper code fields", () => {
  it("lists a transparent one-time-code input under drawn boxes, and nothing else hidden", () => {
    const { browser } = installPageHelper(
      "https://code.example.test/",
      `<input aria-label="Code" autocomplete="one-time-code" style="opacity:0" />
        <input autocomplete="one-time-code" style="opacity:0" />
        <input aria-label="Hidden note" style="opacity:0" />
        <input aria-label="Gone" autocomplete="one-time-code" style="display:none" />`,
    );
    const names = browser.snapshot().elements.map((el) => el.name);
    expect(names).toEqual(["Code", "One-time code"]);
  });

  // Six boxes on one row; `top` places the row on the page.
  const row = (name: string, top: number, attributes = 'maxlength="1"', width = 10) =>
    Array.from(
      { length: 6 },
      (_, i) =>
        `<input aria-label="${name} ${i + 1}" ${attributes} value="${i}" data-rect="${i * 20},${top},${width},10" />`,
    ).join("");
  function typeInto(html: string, name: string) {
    const { domWindow, browser } = installPageHelper("https://code.example.test/", html);
    const { focused } = browser.focusForKeys(refFor(name, browser.snapshot().elements));
    const values = (prefix: string) =>
      Array.from(
        domWindow.document.querySelectorAll<HTMLInputElement>(`[aria-label^="${prefix}"]`),
        (input) => input.value,
      ).join("");
    return { domWindow, browser, focused, values };
  }

  it("empties only the boxes of the code being typed, never another code or field", () => {
    // Two codes on different rows inside one wrapper, and a one-letter field beside them.
    const stacked = typeInto(
      `<main><div>${row("Text", 0)}</div><div>${row("Email", 50)}</div>
        <input aria-label="Initial" maxlength="1" value="Q" data-rect="0,100,10,10" /></main>`,
      "Text 4",
    );
    expect(stacked.focused).toBe(true);
    expect(stacked.values("Text")).toBe("");
    expect(stacked.values("Email")).toBe("012345");
    expect(stacked.values("Initial")).toBe("Q");
    expect(stacked.domWindow.document.activeElement?.getAttribute("aria-label")).toBe("Text 1");
    // Two forms side by side on the same row.
    const sideBySide = typeInto(
      `<div><form>${row("Left", 0)}</form><form>${row("Right", 0)}</form></div>`,
      "Left 1",
    );
    expect([sideBySide.values("Left"), sideBySide.values("Right")]).toEqual(["", "012345"]);
    // Boxes in the same form as a password take in only each other.
    const nextToPassword = typeInto(
      `<form><input aria-label="Password" type="password" value="pw" data-rect="0,0,200,10" />${row("Pin", 0)}</form>`,
      "Pin 1",
    );
    expect(nextToPassword.values("Pin")).toBe("");
    expect(
      nextToPassword.domWindow.document.querySelector<HTMLInputElement>('[type="password"]')?.value,
    ).toBe("pw");
  });

  it("empties a row of equal narrow boxes without a one-character limit, but not two short fields", () => {
    expect(typeInto(`<div>${row("Box", 0, "")}</div>`, "Box 3").values("Box")).toBe("");
    const date = typeInto(
      `<div><input aria-label="Day" maxlength="2" value="24" data-rect="0,0,20,10" />
        <input aria-label="Month" maxlength="2" value="10" data-rect="30,0,20,10" /></div>`,
      "Day",
    );
    expect([date.values("Day"), date.values("Month")]).toEqual(["", "10"]);
  });

  it("keeps typing while focus moves between the code's boxes, and stops anywhere else", () => {
    const { domWindow, browser } = typeInto(
      `<div>${row("Code", 0)}</div><input aria-label="Email" data-rect="0,50,200,10" />`,
      "Code 1",
    );
    const focus = (name: string) =>
      domWindow.document.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)?.focus();
    expect(browser.focusHolds()).toBe(true);
    focus("Code 4");
    expect(browser.focusHolds()).toBe(true);
    focus("Email");
    expect(browser.focusHolds()).toBe(false);
    focus("Code 5");
    domWindow.document.querySelector("div")?.remove();
    expect(browser.focusHolds()).toBe(false);
  });

  it("leaves a one-letter field just before the code out of it, by its name or its size", () => {
    const named = typeInto(
      `<div><input aria-label="Middle initial" maxlength="1" value="Q" data-rect="0,0,10,10" />${row("Digit", 0)}</div>`,
      "Digit 1",
    );
    expect(named.focused).toBe(true);
    expect([named.values("Middle"), named.values("Digit")]).toEqual(["Q", ""]);
    expect(named.domWindow.document.activeElement?.getAttribute("aria-label")).toBe("Digit 1");
    // Typing into the one-letter field itself empties only that field.
    const own = typeInto(
      `<div><input aria-label="Middle initial" maxlength="1" value="Q" data-rect="0,0,10,10" />${row("Digit", 0)}</div>`,
      "Middle initial",
    );
    expect([own.values("Middle"), own.values("Digit")]).toEqual(["", "012345"]);
    const wider = typeInto(
      `<div><input maxlength="1" placeholder="M" value="Q" data-rect="0,0,30,10" />${Array.from(
        { length: 6 },
        (_, i) =>
          `<input maxlength="1" placeholder="-" value="${i}" data-rect="${40 + i * 20},0,10,10" />`,
      ).join("")}</div>`,
      "-",
    );
    const inputs = Array.from(
      wider.domWindow.document.querySelectorAll("input"),
      (input) => (input as HTMLInputElement).value,
    );
    expect(inputs).toEqual(["Q", "", "", "", "", "", ""]);
  });

  it("keeps a wrapped final digit with its named code", () => {
    const wrapped = typeInto(
      `<div><input aria-label="Middle initial" maxlength="1" value="Q" />${row("Digit", 0).replace("100,0,10,10", "0,20,10,10")}</div>`,
      "Digit 1",
    );
    expect([wrapped.values("Middle"), wrapped.values("Digit")]).toEqual(["Q", ""]);
    const last =
      wrapped.domWindow.document.querySelector<HTMLInputElement>('[aria-label="Digit 6"]')!;
    last.focus();
    expect(wrapped.browser.focusHolds()).toBe(true);
  });

  it("still joins a code split into three-box subgroups", () => {
    const boxes = row("Digit", 0)
      .split(" />")
      .filter(Boolean)
      .map((box) => `${box} />`);
    const split = typeInto(
      `<div><span>${boxes.slice(0, 3).join("")}</span>-<span>${boxes.slice(3).join("")}</span></div>`,
      "Digit 4",
    );
    expect(split.values("Digit")).toBe("");
    expect(split.domWindow.document.activeElement?.getAttribute("aria-label")).toBe("Digit 1");
  });

  it("joins a code split into four-box subgroups and keeps typing through both", () => {
    const boxes = Array.from(
      { length: 8 },
      (_, i) => `<input aria-label="Digit ${i + 1}" maxlength="1" value="${i}" />`,
    );
    const { domWindow, browser, values } = typeInto(
      `<div><span>${boxes.slice(0, 4).join("")}</span>-<span>${boxes.slice(4).join("")}</span></div>`,
      "Digit 5",
    );
    expect(values("Digit")).toBe("");
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    expect(domWindow.document.activeElement).toBe(inputs[0]);
    for (const [i, digit] of Array.from("48291375").entries()) {
      inputs[i]!.focus();
      expect(browser.focusHolds()).toBe(true);
      inputs[i]!.value = digit;
      inputs[i]!.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
    }
    expect(values("Digit")).toBe("48291375");
    expect(browser.typed(refFor("Digit 5", browser.snapshot().elements), "48291375")).toBe(true);
  });

  it("keeps adjacent same-named codes in their own containers", () => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<form><div>${row("Digit", 0)}</div><div>${row("Digit", 0)}</div></form>`,
    );
    browser.focusForKeys(browser.snapshot().elements[8]!.ref);
    const groups = domWindow.document.querySelectorAll("div");
    const values = (group: Element) =>
      Array.from(group.querySelectorAll("input"), (box) => box.value).join("");
    expect([values(groups[0]!), values(groups[1]!)]).toEqual(["012345", ""]);
    expect(domWindow.document.activeElement).toBe(groups[1]!.firstElementChild);
  });

  it.each([
    ["shared id prefix", (i: number) => `id="otp-1-${i}"`],
    ["shared name prefix", (i: number) => `name="code1_digit${i}"`],
    ["React ids", (i: number) => `id=":r${i + 1}:"`],
    ["shared React id", (_: number) => 'id=":r1:"'],
    ["React ids with suffix", (i: number) => `id=":r5:-input${i}"`],
    ["generated ids", (i: number) => `id="input-${[17, 23, 19, 31, 28, 42][i]}"`],
    ["labels with total", (i: number) => `aria-label="Digit ${i + 1} of 6"`],
    ["labels with shared total first", (i: number) => `aria-label="6-digit code, digit ${i + 1}"`],
  ])("keeps a single code together with %s", (_, attributes) => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${Array.from(
        { length: 6 },
        (_, i) =>
          `<input ${attributes(i)} maxlength="1" value="${i}" data-rect="${i * 20},0,10,10" />`,
      ).join("")}</div>`,
    );
    browser.focusForKeys(browser.snapshot().elements[3]!.ref);
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    expect(inputs.map((box) => box.value)).toEqual(Array(6).fill(""));
    expect(domWindow.document.activeElement).toBe(inputs[0]);
    for (const input of inputs) {
      input.focus();
      expect(browser.focusHolds()).toBe(true);
    }
  });

  it("joins consecutively numbered boxes across a wide gap", () => {
    const { domWindow, browser, values } = typeInto(
      `<div>${Array.from(
        { length: 6 },
        (_, i) =>
          `<input aria-label="Digit ${i + 1}" maxlength="1" value="${i}" data-rect="${i * 40 + (i >= 3 ? 96 : 0)},0,40,40" />`,
      ).join("")}</div>`,
      "Digit 4",
    );
    expect(values("Digit")).toBe("");
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    expect(domWindow.document.activeElement).toBe(inputs[0]);
    for (const input of inputs) {
      input.focus();
      expect(browser.focusHolds()).toBe(true);
    }
  });

  it("joins name-only numbered boxes across a wide gap", () => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${Array.from(
        { length: 6 },
        (_, i) =>
          `<input name="otp-${i + 1}" maxlength="1" value="${i}" data-rect="${i * 40 + (i >= 3 ? 96 : 0)},0,40,40" />`,
      ).join("")}</div>`,
    );
    browser.focusForKeys(browser.snapshot().elements[3]!.ref);
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    expect(inputs.map((box) => box.value)).toEqual(Array(6).fill(""));
    expect(domWindow.document.activeElement).toBe(inputs[0]);
    for (const input of inputs) {
      input.focus();
      expect(browser.focusHolds()).toBe(true);
    }
  });

  it.each([
    ["labels", (i: number) => `aria-label="Digit ${(i % 6) + 1}"`],
    ["names", (i: number) => `name="otp-${(i % 6) + 1}"`],
  ] as const)("types both codes across wide gaps with restarting %s", (_, attributes) => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${Array.from(
        { length: 12 },
        (_, i) =>
          `<input ${attributes(i)} maxlength="1" value="${i % 6}" data-rect="${Math.floor(i / 6) * 400 + (i % 6) * 40 + (i % 6 >= 3 ? 96 : 0)},0,40,40" />`,
      ).join("")}</div>`,
    );
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    const refs = browser.snapshot().elements.map((element) => element.ref);
    const values = () => [
      inputs
        .slice(0, 6)
        .map((box) => box.value)
        .join(""),
      inputs
        .slice(6)
        .map((box) => box.value)
        .join(""),
    ];
    for (const offset of [6, 0]) {
      const ref = refs[offset + 3]!;
      expect(browser.focusForKeys(ref).focused).toBe(true);
      expect(values()).toEqual(offset === 6 ? ["012345", ""] : ["", "482913"]);
      expect(domWindow.document.activeElement).toBe(inputs[offset]);
      for (const [i, digit] of Array.from("482913").entries()) {
        const box = inputs[offset + i]!;
        box.focus();
        expect(browser.focusHolds()).toBe(true);
        box.value = digit;
        box.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
      }
      expect(browser.typed(ref, "482913")).toBe(true);
      expect(values()).toEqual(offset === 6 ? ["012345", "482913"] : ["482913", "482913"]);
    }
  });

  it("keeps a code together across a dash with a two-box-wide separator", () => {
    const boxes = Array.from(
      { length: 6 },
      (_, i) =>
        `${i === 3 ? "<span>-</span>" : ""}<input maxlength="1" value="${i}" data-rect="${i * 20 + (i >= 3 ? 10 : 0)},0,10,10" />`,
    ).join("");
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${boxes}</div>`,
    );
    browser.focusForKeys(browser.snapshot().elements[4]!.ref);
    expect(Array.from(domWindow.document.querySelectorAll("input"), (box) => box.value)).toEqual(
      Array(6).fill(""),
    );
  });

  it.each([
    // Named "Digit 1" to "Digit 6" twice, side by side.
    [
      "box numbers start again",
      `${row("Digit", 0)}${row("Digit", 0).replace(/data-rect="(\d+)/g, (_, x) => `data-rect="${Number(x) + 120}`)}`,
    ],
    [
      "zero-based box numbers start again",
      `${row("Digit", 0)}${row("Digit", 0).replace(/data-rect="(\d+)/g, (_, x) => `data-rect="${Number(x) + 120}`)}`.replace(
        /aria-label="Digit (\d)"/g,
        (_, digit) => `aria-label="Digit ${Number(digit) - 1}"`,
      ),
    ],
    ...(
      [
        ["consecutive generated ids", (i: number) => `id="input-${i + 17}"`],
        ["numbered names", (i: number) => `name="otp-${(i % 6) + 1}"`],
        ["names continue across a wide gap", (i: number) => `name="otp-${i + 1}"`],
        ["labels continue across a wide gap", (i: number) => `aria-label="Digit ${i + 1}"`],
        ["labels starting above one", (i: number) => `aria-label="Digit ${i + 17}"`],
      ] as const
    ).map(([description, attributes]) => [
      description,
      Array.from(
        { length: 12 },
        (_, i) =>
          `<input ${attributes(i)} maxlength="1" value="${i % 6}" data-rect="${i < 6 ? i * 20 : 300 + (i - 6) * 20},0,10,10" />`,
      ).join(""),
    ]),
    // Unnamed, with a wide gap between the two codes.
    [
      "a wide gap follows",
      Array.from(
        { length: 12 },
        (_, i) =>
          `<input maxlength="1" value="${i % 6}" data-rect="${i < 6 ? i * 20 : 300 + (i - 6) * 20},0,10,10" />`,
      ).join(""),
    ],
  ])("keeps two codes in one container apart where %s", (_, boxes) => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${boxes}</div>`,
    );
    browser.focusForKeys(browser.snapshot().elements[6]!.ref);
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    expect(inputs.map((box) => box.value).join("")).toBe("012345");
    expect(domWindow.document.activeElement).toBe(inputs[6]);
    inputs[6]!.value = "9";
    inputs[6]!.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
    expect(
      inputs
        .slice(0, 6)
        .map((box) => box.value)
        .join(""),
    ).toBe("012345");
    expect(
      inputs
        .slice(6)
        .map((box) => box.value)
        .join(""),
    ).toBe("9");
  });

  it.each([false, true])(
    "stops when another widget replaces the target (same container: %s)",
    (sameContainer) => {
      const { domWindow, browser } = typeInto(
        `<main><div>${row("Code", 0)}</div></main>`,
        "Code 1",
      );
      const group = domWindow.document.querySelector("div")!;
      if (sameContainer) group.innerHTML = row("Other", 0);
      else group.outerHTML = `<div>${row("Code", 0)}</div>`;
      domWindow.document.querySelector<HTMLInputElement>("input")!.focus();
      expect(browser.focusHolds()).toBe(false);
      expect(
        Array.from(domWindow.document.querySelectorAll("input"), (box) => box.value).join(""),
      ).toBe("012345");
    },
  );

  it("lets a code be typed box by box, with or without the widget moving on", () => {
    for (const advances of [false, true]) {
      const { domWindow, browser } = installPageHelper(
        "https://code.example.test/",
        `<div>${row("Digit", 0).replace(/value="\d"/g, 'value=""')}</div>`,
      );
      const document = domWindow.document;
      const boxes = Array.from(document.querySelectorAll("input"));
      if (advances) {
        for (const [i, box] of boxes.entries()) {
          box.addEventListener("input", () => {
            if (box.value) boxes[i + 1]?.focus();
          });
        }
      }
      const refs = browser.snapshot().elements.map((element) => element.ref);
      for (const [i, digit] of Array.from("482913").entries()) {
        // One character typed into each box, as a keyboard would put it there.
        expect(browser.focusForKeys(refs[i]!, false).focused, `box ${i + 1}`).toBe(true);
        const active = document.activeElement as HTMLInputElement;
        active.value = digit;
        active.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
        expect(browser.typed(refs[i]!, digit)).toBe(true);
      }
      expect(boxes.map((box) => box.value).join(""), advances ? "auto-advance" : "plain").toBe(
        "482913",
      );
      // A whole code typed again still replaces every box.
      browser.focusForKeys(refs[3]!, true);
      expect(boxes.map((box) => box.value).join("")).toBe("");
      expect(document.activeElement).toBe(boxes[0]);
    }
  });

  it("types into a code whose widget replaces its boxes on every input", () => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${row("Code", 0)}</div>`,
    );
    const document = domWindow.document;
    const group = document.querySelector("div") as HTMLDivElement;
    // Like a widget that renders its boxes again from its own state, focusing the same place.
    group.addEventListener("input", (event) => {
      const at = Array.prototype.indexOf.call(group.children, event.target);
      const focused = Array.prototype.indexOf.call(group.children, document.activeElement);
      for (const old of Array.from(group.children) as HTMLInputElement[]) {
        const box = old.cloneNode() as HTMLInputElement;
        box.value = old.value;
        old.replaceWith(box);
      }
      (group.children[focused >= 0 ? focused : at] as HTMLInputElement | undefined)?.focus();
    });
    const ref = refFor("Code 3", browser.snapshot().elements);
    const { focused } = browser.focusForKeys(ref);
    expect(focused).toBe(true);
    expect(Array.from(group.children, (box) => (box as HTMLInputElement).value).join("")).toBe("");
    expect(document.activeElement).toBe(group.children[0]);
    // The widget moves on to its next box, which it has just created again.
    group.children[0]?.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
    (group.children[1] as HTMLInputElement).focus();
    expect(browser.focusHolds()).toBe(true);
    // What landed is read from the new boxes.
    for (const [i, box] of Array.from(group.children).entries())
      (box as HTMLInputElement).value = "482913"[i]!;
    expect([browser.typed(ref, "482913"), browser.typed(ref, "111111")]).toEqual([true, false]);
    // An empty widget sees no events from emptying it.
    const quiet = installPageHelper(
      "https://code.example.test/",
      `<div>${row("Code", 0, 'maxlength="1"').replace(/value="\d"/g, 'value=""')}</div>`,
    );
    let events = 0;
    quiet.domWindow.document.addEventListener("input", () => events++);
    expect(
      quiet.browser.focusForKeys(refFor("Code 1", quiet.browser.snapshot().elements)).focused,
    ).toBe(true);
    expect(events).toBe(0);
  });
});

describe("live page helper upload targets", () => {
  it("lists hidden and role-overridden file inputs without crowding out page controls", () => {
    const hidden = Array.from(
      { length: 80 },
      (_, i) => `<input type="file" aria-label="Hidden ${i}" style="display:none" />`,
    ).join("");
    const { browser } = installPageHelper(
      "https://upload.example.test/",
      `${hidden}<input type="file" role="button" aria-label="Receipt" /><button>Save</button>`,
    );
    const { elements } = browser.snapshot();
    expect(elements.find((el) => el.name === "Save")?.role).toBe("button");
    expect(elements.find((el) => el.name === "Receipt")?.role).toBe("file upload");
    expect(elements.filter((el) => el.role === "file upload")).toHaveLength(81);
  });
});
