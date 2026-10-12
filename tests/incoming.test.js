// Incoming: emails, voicemails, website forms and logged calls in one list,
// grouped by what they need, with one main button each. Website forms
// confirmed from here (or anywhere) land in the customer's correspondence.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readDoc, readCollection, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const EMAIL = "reserve@qicampark.com";
const seed = () => resetData({
  "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], parts: [], workOrderTemplates: [], cannedReplies: [], userRoles: { [EMAIL]: "admin" } },
  "sites/a": { id: "a", number: "1051", section: "Pebble Beach", tags: [] },
  "sites/b": { id: "b", number: "0020", section: "Front of Park", tags: [] },
  "cottages/k1": { id: "k1", name: "Loon", siteId: "a", appliances: [{ id: "ap1", type: "Furnace", make: "Suburban", model: "P-40" }, { id: "ap2", type: "Refrigerator", make: "Dometic" }] },
  "customers/c1": { id: "c1", name: "Robert & Linda Smith", phone: "6135550148", email: "rob@x.com", siteIds: ["a"], siteId: "a" },
  "customers/c2": { id: "c2", name: "Ann Lee", phone: "6135550199", email: "ann@x.com", siteIds: ["b"], siteId: "b" },
  "correspondence/m1": { id: "m1", direction: "in", status: "new", customerId: "c1", fromEmail: "rob@x.com", fromName: "Linda Smith", subject: "Furnace noise", body: "The furnace is clicking again. Can someone look before the weekend?", receivedAt: "2026-10-09T13:14:00Z", triage: { category: "service", summary: "Furnace clicking on start-up", priority: "High", siteNumber: null, needsReply: true } },
  "correspondence/m2": { id: "m2", direction: "in", status: "new", customerId: "c2", fromEmail: "ann@x.com", subject: "Propane", body: "Our propane tank is empty, can you fill it?", receivedAt: "2026-10-09T12:00:00Z", triage: { category: "propane", summary: "Propane tank empty", priority: "Medium", siteNumber: null, needsReply: true } },
  "correspondence/m3": { id: "m3", direction: "in", status: "new", customerId: "c1", fromEmail: "rob@x.com", subject: "Re: Deck board", body: "Any update on the deck board?", receivedAt: "2026-10-08T12:00:00Z" },
  "correspondence/m4": { id: "m4", direction: "in", status: "new", fromEmail: "stranger@x.com", subject: "Hydro bill", body: "My hydro bill seems high, I'm on site 20.", receivedAt: "2026-10-08T11:00:00Z", triage: { category: "other", summary: "Hydro reading looks wrong", priority: "Low", siteNumber: "20", needsReply: true } },
  "workOrders/w1": { id: "w1", workOrderNumber: "WO-0440", title: "Deck board loose", status: "Open", siteId: "a", cottageId: "k1", customerId: "c1", date: "2026-10-07", notes: [], partsUsed: [] },
  "pendingSignups/p1": { type: "generalservice", submittedName: "Robert Smith", submittedEmail: "rob@x.com", submittedPhone: "6135550148", submittedSiteNumber: "1051", submittedCategory: "Sliding door", submittedDescription: "Patio door came off the track.", submittedUrgency: "Medium", receivedAt: "2026-10-09T14:00:00Z" },
  "pendingSignups/p2": { type: "propane", submittedName: "Ann Lee", submittedEmail: "ann@x.com", submittedSiteNumber: "20", requestedDate: "2026-10-20", receivedAt: "2026-10-09T10:00:00Z" }
});
const view = `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(IncomingView, { db: api.db, persist: api.persist, pendingSignups: api.pendingSignups, confirmPendingSignup: api.confirmPendingSignup, removePendingSignup: api.removePendingSignup, saveCorrespondence: api.saveCorrespondence, saveCustomer: api.saveCustomer, saveWorkOrder: api.saveWorkOrder, savePropaneRequest: api.savePropaneRequest, saveTreeRequest: api.saveTreeRequest, saveWinterizingRequest: api.saveWinterizingRequest, onGoToTab: () => {} }))`;
const READY = "(api) => api.db.customers.length === 2 && api.db.cottages.length >= 1 && api.db.correspondence.length >= 4 && api.pendingSignups.length >= 1";

async function open(page) {
  await page.clock.setFixedTime(new Date("2026-10-09T15:00:00Z"));
  await mountWithDb(page, view, READY);
}
const group = (page, key) => page.locator(`[data-incoming-group="${key}"] [data-incoming-row]`);

test("requests are grouped by what they need; strangers ask who they are", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await open(page);
  await waitFor(async () => (await group(page, "runs").count()) === 2, "propane email + propane form");
  assert.equal(await group(page, "work").count(), 2); // furnace email + service form
  assert.equal(await group(page, "existing").count(), 1); // "Re: Deck board" with WO-0440 open
  assert.equal(await group(page, "answer").count(), 1);
  await page.locator('[data-incoming-row="c-m4"]').getByText("who is this?").waitFor();
  // The stranger names site 20, which is Ann's: one click links them.
  await page.locator('[data-incoming-row="c-m4"]').click();
  await page.getByRole("button", { name: "It's Ann Lee" }).click();
  await waitFor(async () => (await readDoc("correspondence/m4")).customerId === "c2", "the email to be linked to Ann");
  await waitFor(async () => ((await readDoc("customers/c2")).matchEmails || []).includes("stranger@x.com"), "the address to be remembered");
  // About an existing job shows the open work order.
  await page.locator('[data-incoming-row="c-m3"]').click();
  await page.getByText("About an existing job", { exact: true }).waitFor();
  await page.getByText("WO-0440 · Deck board loose").waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("an email becomes a work order in one click, with the appliance and priority filled in", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await page.evaluate(() => { window.__sent = []; window.sendEmail = async (m) => { window.__sent.push(m); return { ok: true }; }; });
  await open(page);
  await page.locator('[data-incoming-row="c-m1"]').click();
  await page.getByText("Work order, ready to create").waitFor();
  await page.getByText("Furnace — Suburban P-40").waitFor();
  await page.locator("[data-incoming-main]").click();
  const wo = await waitFor(async () => (await readCollection("workOrders")).find((w) => w.id !== "w1"), "the work order");
  assert.equal(wo.customerId, "c1");
  assert.equal(wo.siteId, "a");
  assert.equal(wo.cottageId, "k1");
  assert.equal(wo.applianceId, "ap1");
  assert.equal(wo.priority, "High");
  assert.equal(wo.status, "Open");
  const m1 = await waitFor(async () => { const d = await readDoc("correspondence/m1"); return d.status === "handled" && d; }, "the email to be handled");
  assert.equal(m1.workOrderId, wo.id);
  // Optional note to the customer, already written.
  await page.locator("[data-incoming-done]").waitFor();
  const box = page.locator("textarea").first();
  assert.match(await box.inputValue(), /booked someone/);
  await page.getByRole("button", { name: /^Send/ }).click();
  await waitFor(async () => (await page.evaluate(() => window.__sent)).length === 1, "the email to send");
  assert.equal((await page.evaluate(() => window.__sent))[0].toEmail, "rob@x.com");
  assert.equal(await page.locator('[data-incoming-row="c-m1"]').count(), 0);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("a website service request is confirmed from Incoming and lands in the customer's correspondence", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await open(page);
  await page.locator('[data-incoming-row="s-p1"]').click();
  await page.locator("[data-incoming-main]").click();
  await page.getByRole("button", { name: "Create Work Order" }).last().click();
  await waitFor(async () => !(await readCollection("pendingSignups")).some((p) => p.id === "p1"), "the sign-up to be used up");
  const wo = (await readCollection("workOrders")).find((w) => w.sourceType === "generalServiceRequest");
  assert.ok(wo);
  const msg = await waitFor(() => readDoc("correspondence/webform_p1"), "the form to be saved as a message");
  assert.equal(msg.customerId, "c1");
  assert.equal(msg.direction, "in");
  assert.equal(msg.source, "webform");
  assert.equal(msg.status, "handled");
  assert.equal(msg.workOrderId, wo.id);
  assert.match(msg.subject, /Service request/);
  assert.match(msg.body, /Patio door came off the track/);
  await page.locator("[data-incoming-done]").waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("a phone call logged here shows up in Incoming and the customer's history", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await open(page);
  await page.getByRole("button", { name: /Log a call/ }).click();
  const input = page.getByPlaceholder("Search customers or site #…");
  await input.click();
  await input.fill("0020");
  await page.getByRole("button", { name: "Ann Lee", exact: true }).click();
  await page.getByPlaceholder(/Water under the hot water tank/).fill("Water under the hot water tank, wants someone today");
  await page.getByRole("button", { name: "Add to Incoming" }).click();
  const rec = await waitFor(async () => (await readCollection("correspondence")).find((c) => c.source === "phone"), "the call to save");
  assert.equal(rec.customerId, "c2");
  assert.equal(rec.status, "new");
  assert.match(rec.subject, /^Phone call: Water under/);
  await page.locator(`[data-incoming-row="c-${rec.id}"]`).waitFor();
  assert.equal(await page.locator(`[data-incoming-group="work"] [data-incoming-row="c-${rec.id}"]`).count(), 1);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("the menu has Incoming and no longer Service Requests; the dashboard's sign-ups card opens Incoming", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  const menu = await page.evaluate(() => ({
    today: SERVICE_NAV_GROUPS[0].items,
    tabs: TABS.filter((t) => t.group === "service").map((t) => t.key)
  }));
  assert.ok(menu.today.includes("incoming"));
  assert.ok(menu.tabs.includes("incoming"));
  assert.ok(!menu.today.includes("generalservice"));
  assert.ok(!menu.tabs.includes("generalservice"));
  await mountWithDb(page, `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(DashboardView, { db: api.db, persist: api.persist, onGoToTab: (t) => { window.__went = t; }, onSearchJump() {}, allowedTabKeys: null, pendingSignups: api.pendingSignups, removePendingSignup() {}, saveWorkOrder() {}, saveCorrespondence() {} }))`, READY);
  await page.getByText("Sign-Ups Needing Review").first().click();
  assert.equal(await page.evaluate(() => window.__went), "incoming");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("a form confirmed with only the cottage picked still goes in the owner's correspondence", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await mountWithDb(page, "() => null", READY + " && api.db.cottages.length >= 1 && api.pendingSignups.length >= 2");
  await page.evaluate(() => window.__api.confirmPendingSignup(PROPANE_REQUESTS_REF, { id: "r1", cottageId: "k1", customerId: null, requestedDate: "2026-10-20", run: "10am", notes: "", completed: false }, "p2"));
  const msg = await waitFor(() => readDoc("correspondence/webform_p2"), "the form to be saved as a message");
  assert.equal(msg.customerId, "c1");
  assert.equal(msg.propaneRequestId, "r1");
  assert.equal(msg.receivedAt, "2026-10-09T10:00:00Z");
  assert.match(msg.body, /Requested date: 2026-10-20/);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("a website service request Claude has read: title, priority and appliance carry into the work order", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await page.evaluate(() => firebase.firestore().doc("pendingSignups/p3").set({ type: "generalservice", submittedName: "Linda Smith", submittedEmail: "rob@x.com", submittedSiteNumber: "1051", submittedDescription: "Our fridge isn't cooling since yesterday.", receivedAt: "2026-10-09T14:30:00Z", triage: { category: "service", summary: "Fridge not cooling", priority: "High", siteNumber: "1051", requestedDate: null } }));
  await open(page);
  await page.locator('[data-incoming-row="s-p3"]').waitFor();
  await page.locator('[data-incoming-row="s-p3"]').click();
  await page.getByText("Fridge not cooling").first().waitFor();
  await page.getByText("Refrigerator — Dometic").waitFor();
  await page.locator("[data-incoming-main]").click();
  await page.getByRole("button", { name: "Create Work Order" }).last().click();
  const wo = await waitFor(async () => (await readCollection("workOrders")).find((w) => w.sourceType === "generalServiceRequest"), "the work order");
  assert.equal(wo.title, "Fridge not cooling");
  assert.equal(wo.priority, "High");
  assert.equal(wo.applianceId, "ap2");
  assert.equal(wo.cottageId, "k1");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
