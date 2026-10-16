// Errors on staff devices are recorded for System Health: uncaught errors,
// a crashed screen (which no longer offers "Reset all data"), and failed
// saves - and Admins see them grouped in the panel.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readCollection, readDoc, writeDoc, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });
beforeEach(async () => {
  await resetData({ "campground/data": { settings: {}, activityLog: [], staff: [], parts: [], workOrderTemplates: [], userRoles: { "boss@qicampark.com": "admin", "dave@qicampark.com": "office" } } });
});
const errorsMatching = (re, kind) => waitFor(async () => (await readCollection("clientErrors")).find((e) => re.test(e.message) && (!kind || e.kind === kind)), `a${kind ? " " + kind : "n error"} report matching ${re}`);

test("An uncaught error on a staff device is recorded once, with who and where", async () => {
  const page = await openApp(browser, "emulator", { role: "office", email: "dave@qicampark.com", viewport: { width: 390, height: 800 } });
  await page.evaluate(() => { window.__qicScreen = "propane"; setTimeout(() => { throw new Error("Boom from a test"); }); setTimeout(() => { throw new Error("Boom from a test"); }, 50); });
  const e = await errorsMatching(/Boom from a test/);
  assert.equal(e.kind, "error");
  assert.equal(e.email, "dave@qicampark.com");
  assert.equal(e.device, "phone");
  assert.equal(e.screen, "propane");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await readCollection("clientErrors")).length, 1, "the same error is only sent once per page load");
  await page.close();
});

test("A crashed screen is recorded, and the crash screen no longer offers to reset all data", async () => {
  const page = await openApp(browser, "emulator", { role: "office", email: "dave@qicampark.com" });
  await page.evaluate(() => {
    function Broken() { throw new Error("Screen exploded"); }
    ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(ErrorBoundary, null, React.createElement(Broken)));
  });
  await page.getByText("Something went wrong.").waitFor();
  assert.equal(await page.getByRole("button", { name: /Reset all data/ }).count(), 0);
  await page.getByText(/this error has been recorded in System Health/).waitFor();
  // (React's development build also reports it as a plain error; the
  // production build only reports the crash.)
  const e = await errorsMatching(/Screen exploded/, "crash");
  assert.match(e.stack, /Broken/);
  await page.close();
});

test("A failed save is recorded", async () => {
  const page = await openApp(browser, "emulator", { role: "office", email: "dave@qicampark.com" });
  await mountWithDb(page, "(api) => React.createElement('div', null, 'ready')");
  await page.evaluate(() => {
    const proto = Object.getPrototypeOf(WORK_ORDERS_REF.doc("x"));
    const realSet = proto.set;
    proto.set = function (data, opts) {
      if (this.parent && this.parent.id === "workOrders") return Promise.reject(new Error("Simulated failure"));
      return realSet.call(this, data, opts);
    };
    window.__api.saveWorkOrder({ id: "w1", title: "Won't save" });
  });
  const e = await errorsMatching(/Couldn't save that work order/, "save");
  assert.equal(e.kind, "save");
  await page.close();
});

test("Admins see errors grouped in System Health and can clear them", async () => {
  const base = { stack: "Error: x\n at y", device: "phone", screen: "workorders", userAgent: "UA", day: "2026-10-01" };
  const now = Date.now();
  await writeDoc("clientErrors/a", { ...base, kind: "error", message: "Cannot read properties of undefined", email: "dave@qicampark.com", ts: new Date(now - 60000).toISOString() });
  await writeDoc("clientErrors/b", { ...base, kind: "error", message: "Cannot read properties of undefined", email: "sue@qicampark.com", ts: new Date(now - 30000).toISOString() });
  await writeDoc("clientErrors/c", { ...base, kind: "save", message: "Couldn't save that invoice", email: "dave@qicampark.com", ts: new Date(now).toISOString() });
  await writeDoc("clientErrors/old", { ...base, kind: "error", message: "Ancient", email: "x@qicampark.com", ts: new Date(now - 40 * 864e5).toISOString() });
  const page = await openApp(browser, "emulator", { role: "admin", email: "boss@qicampark.com" });
  await mountWithDb(page, `(api) => React.createElement(CurrentUserContext.Provider, { value: "boss@qicampark.com" }, React.createElement(ClientErrorsPanel, { db: api.db }))`);
  await page.getByText("Cannot read properties of undefined").waitFor();
  const text = await page.locator("#root").textContent();
  assert.match(text, /2 times/);
  assert.match(text, /sue@qicampark\.com, dave@qicampark\.com/, "who saw it, most recent first");
  assert.match(text, /Save failed/);
  await waitFor(async () => !(await readCollection("clientErrors")).some((e) => e.message === "Ancient"), "records over 30 days old to be cleared");
  await page.getByRole("button", { name: "Clear" }).first().click();
  await waitFor(async () => (await readCollection("clientErrors")).length === 2 || (await readCollection("clientErrors")).length === 1, "a group to be cleared");
  await page.close();
});

test("Email Intake: the Zoho inbox check shows how it compares with Flow, and switches on with a confirm", async () => {
  await writeDoc("serverState/zohoInbox", { checkedAt: new Date().toISOString(), compare: { since: "2026-10-09T12:00:00Z", checked: 12, matched: 11, missedCount: 1, missed: [{ messageId: "m1", from: "news@shop.com", subject: "Fall sale", at: "2026-10-09T13:00:00Z" }] } });
  const page = await openApp(browser, "emulator", { role: "admin", email: "boss@qicampark.com" });
  await mountWithDb(page, `(api) => React.createElement(CurrentUserContext.Provider, { value: "boss@qicampark.com" }, React.createElement(EmailIntakePane, { db: api.db, persist: api.persist }))`);
  const box = page.locator("[data-zoho-inbox]");
  await box.locator("[data-zoho-compare]").getByText("11 of 12").waitFor();
  await box.getByText("news@shop.com", { exact: false }).waitFor();
  await box.getByRole("button", { name: "Switch on" }).click();
  await box.getByRole("button", { name: "Yes, switch on" }).click();
  await box.getByText("On", { exact: true }).waitFor();
  await waitFor(async () => { const d = await readDoc("campground/data"); return d && d.settings && d.settings.emailIntakeDirect === true; }, "the switch to be saved");
  // The Done folder: how to set it up, then what it's done once it's there.
  await writeDoc("serverState/zohoInbox", { checkedAt: new Date().toISOString(), direct: true, done: { folder: false, checkedAt: new Date().toISOString() } });
  await box.locator("[data-zoho-done='off']").getByText('Make a folder called "Done"', { exact: false }).waitFor();
  await writeDoc("serverState/zohoInbox", { checkedAt: new Date().toISOString(), direct: true, done: { folder: true, checkedAt: new Date().toISOString(), movedTotal: 4, handledTotal: 2 } });
  await box.locator("[data-zoho-done='on']").getByText("4 moved to Done, 2 marked handled from Zoho", { exact: false }).waitFor();
  await page.close();
});

test("A save by someone who can't change app settings keeps the saved settings and still goes through", async () => {
  await writeDoc("campground/data", { settings: { taxRate: 13 }, activityLog: [], staff: [], parts: [], workOrderTemplates: [], loginCodes: { k: { required: true, codes: ["1"] } }, userRoles: { "boss@qicampark.com": "admin", "dave@qicampark.com": "office" } });
  const page = await openApp(browser, "emulator", { role: "office", email: "dave@qicampark.com" });
  await mountWithDb(page, "(api) => React.createElement('div', null, 'ready')");
  // A screen holding an older copy (tax 10, no sign-in codes) saves the activity log.
  const ok = await page.evaluate(() => window.__api.persist({ ...window.__api.db, settings: { taxRate: 10, coupleNamesReviewed: ["c1"] }, loginCodes: {}, activityLog: [{ id: "a1", text: "hi" }] }));
  assert.equal(ok, true);
  const saved = await readDoc("campground/data");
  assert.equal(saved.settings.taxRate, 13);
  assert.deepEqual(saved.settings.coupleNamesReviewed, ["c1"]);
  assert.deepEqual(saved.loginCodes, { k: { required: true, codes: ["1"] } });
  assert.equal(saved.activityLog[0].text, "hi");
  await page.close();
});

test("Activity History: Admins page through the server's record, newest first, with what changed and deleted copies", async () => {
  for (let i = 0; i < 205; i++) await writeDoc(`auditLog/p${String(i).padStart(3, "0")}`, { ts: new Date(Date.UTC(2026, 8, 1, 12, 0, i)).toISOString(), by: "dave@qicampark.com", collection: "parts", docId: "x", action: "changed", label: `Part ${i}`, changes: [{ field: "price", from: "1", to: "2" }] });
  await writeDoc("auditLog/new1", { ts: "2026-10-14T15:00:00.000Z", by: "sue@qicampark.com", collection: "customers", docId: "c1", action: "changed", label: "Jane Doe", changes: [{ field: "phone", from: "6135550148", to: "6135550199" }] });
  await writeDoc("auditLog/new2", { ts: "2026-10-14T16:00:00.000Z", by: "dave@qicampark.com", collection: "invoices", docId: "i1", action: "deleted", label: "INV-26-0010 \u00b7 Furnace", deletedCopy: JSON.stringify({ invoiceNumber: "INV-26-0010", total: 120 }) });
  const page = await openApp(browser, "emulator", { role: "admin", email: "boss@qicampark.com" });
  await mountWithDb(page, `(api) => React.createElement(ActivityHistoryView, null)`);
  await page.getByText("Jane Doe").waitFor();
  const text = await page.locator("#root").textContent();
  assert.ok(text.indexOf("INV-26-0010") < text.indexOf("Jane Doe"), "newest first");
  assert.match(text, /phone: 6135550148 \u2192 6135550199/);
  await page.getByRole("button", { name: "Show what it was" }).click();
  await page.getByText('"total": 120').waitFor();
  // 200 at a time; the oldest few come with "Show older".
  assert.equal(await page.getByText("Part 2", { exact: true }).count(), 0);
  await page.getByRole("button", { name: /Show older/ }).click();
  await page.getByText("Part 2", { exact: true }).waitFor();
  await page.locator("select").nth(1).selectOption("sue@qicampark.com");
  assert.equal(await page.getByText("Part 2", { exact: true }).count(), 0, "filtered to one person");
  await page.getByText("Jane Doe").waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
