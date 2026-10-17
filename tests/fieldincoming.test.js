// Incoming on a phone (Admins / Service Managers): Today's card and More's
// count lead to it; the same groups and buttons as the computer, one
// request per screen with the main button at the bottom, then an optional
// note to the customer that's already written.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readDoc, readCollection, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const EMAIL = "alex@x.com";
const seed = () => resetData({
  "campground/data": { settings: {}, activityLog: [], staff: [], parts: [], workOrderTemplates: [], cannedReplies: [], userRoles: { [EMAIL]: "admin" } },
  "sites/a": { id: "a", number: "1051" },
  "cottages/k1": { id: "k1", name: "Loon", siteId: "a", appliances: [{ id: "ap1", type: "Furnace", make: "Suburban", model: "P-40" }] },
  "customers/c1": { id: "c1", name: "Robert & Linda Smith", email: "rsmith@bell.net", matchEmails: ["linda.smith@gmail.com"], siteIds: ["a"] },
  "correspondence/m1": { id: "m1", direction: "in", status: "new", customerId: "c1", fromEmail: "linda.smith@gmail.com", fromName: "Linda Smith", subject: "Furnace noise", body: "The furnace is clicking again.", receivedAt: "2026-10-16T13:00:00Z", triage: { category: "service", summary: "Furnace clicking on start-up", priority: "High", needsReply: true } },
  "correspondence/m2": { id: "m2", direction: "in", status: "new", customerId: "c1", fromEmail: "rsmith@bell.net", subject: "Propane", body: "Tank's empty, please fill.", receivedAt: "2026-10-16T12:00:00Z", triage: { category: "propane", summary: "Propane tank empty", priority: "Medium", needsReply: true } },
  "pendingSignups/p1": { type: "generalservice", submittedName: "Robert Smith", submittedEmail: "rsmith@bell.net", submittedSiteNumber: "1051", submittedDescription: "Patio door came off the track.", receivedAt: "2026-10-16T14:00:00Z" }
});
const noop = "() => {}";
const app = `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(FieldApp, { db: api.db, persist: api.persist, actor: "Alex", saveWorkOrder: api.saveWorkOrder, savePropaneRequest: api.savePropaneRequest, saveWinterizingRequest: api.saveWinterizingRequest, saveInvoice: api.saveInvoice, deleteInvoice: ${noop}, saveQuote: api.saveQuote, saveCottage: api.saveCottage, saveSite: api.saveSite, saveCorrespondence: api.saveCorrespondence, deleteCorrespondence: api.deleteCorrespondence, saveCustomer: api.saveCustomer, saveTreeRequest: api.saveTreeRequest, pendingSignups: api.pendingSignups, confirmPendingSignup: api.confirmPendingSignup, removePendingSignup: api.removePendingSignup, isAdminOrManager: true, onCreateInvoice: ${noop}, onGoToDesktopTab: ${noop}, onSignOut: null }))`;
// Ready once the data's in (and stays mounted after the sign-up is used up).
const READY = "(api) => window.__ok || (window.__ok = api.db.correspondence.length >= 2 && api.pendingSignups.length >= 1 && api.db.cottages.length === 1)";

async function phone() {
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL, viewport: { width: 390, height: 800 } });
  await page.evaluate(() => {
    window.history.replaceState({ qicField: { screen: "today", idx: 0 } }, "");
    window.__sent = [];
    window.sendEmail = async (m) => { window.__sent.push(m); return { ok: true }; };
  });
  await mountWithDb(page, app, READY);
  return page;
}

test("Today's card opens Incoming; an email becomes a work order from the big button, then an optional note", async () => {
  await seed();
  const page = await phone();
  await page.locator("[data-today-incoming]").getByText("3 waiting in Incoming").waitFor();
  assert.equal(await page.locator('[data-tab-badge="more"]').innerText(), "3");
  await page.locator("[data-today-incoming]").click();
  assert.equal(await page.locator('[data-incoming-group="work"] [data-incoming-row]').count(), 2);
  assert.equal(await page.locator('[data-incoming-group="runs"] [data-incoming-row]').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.locator('[data-incoming-row="c-m1"]').click();
  await page.getByText("Work order, ready to create").waitFor();
  await page.locator("[data-incoming-actions]").getByRole("button", { name: "Create work order" }).click();
  const wo = await waitFor(async () => (await readCollection("workOrders"))[0], "the work order");
  assert.equal(wo.applianceId, "ap1");
  assert.equal(wo.priority, "High");
  await page.locator("[data-incoming-done]").waitFor();
  assert.match(await page.getByLabel("Note to the customer").inputValue(), /booked someone/);
  await page.locator("[data-incoming-note]").getByRole("button", { name: "Send" }).click();
  await waitFor(async () => (await page.evaluate(() => window.__sent.length)) === 1, "the note to send");
  assert.equal((await page.evaluate(() => window.__sent))[0].toEmail, "linda.smith@gmail.com");
  // Back to the list: one fewer.
  await page.getByRole("button", { name: "← Incoming" }).click();
  await waitFor(async () => (await page.locator("[data-incoming-row]").count()) === 2, "the list to update");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("a website form opens its review form; Done — nothing to do clears an email; Back steps back", async () => {
  await seed();
  const page = await phone();
  await page.locator("[data-today-incoming]").click();
  await page.locator('[data-incoming-row="s-p1"]').click();
  await page.locator("[data-incoming-actions]").getByRole("button", { name: "Create work order" }).click();
  await page.getByRole("button", { name: "Create Work Order" }).last().click();
  await waitFor(async () => !(await readCollection("pendingSignups")).length, "the sign-up to be used");
  await page.locator("[data-incoming-done]").waitFor();
  await page.getByRole("button", { name: "← Incoming" }).click();
  await page.locator('[data-incoming-row="c-m2"]').click();
  await page.getByText("Propane fill, ready to add").waitFor();
  await page.locator("[data-incoming-actions]").getByRole("button", { name: "Done — nothing to do" }).click();
  await waitFor(async () => (await readDoc("correspondence/m2")).status === "handled", "the email to be done");
  // The phone's Back button goes back to the list.
  await page.goBack();
  await page.locator('[data-incoming-row="c-m1"]').waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
