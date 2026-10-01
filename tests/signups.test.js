// Reviewing web-form sign-ups (winterizing, propane, general service)
// through the real review screens: the match is found from the email/phone/
// site, confirming creates the record and removes the pending entry, and the
// sign-up's email is remembered for the customer.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readCollection, readDoc, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor, findIn } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const BASE = {
  "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], parts: [{ id: "tank", name: "100lb Propane Refill Filled", price: 90, quantity: 0, trackQuantity: false }], workOrderTemplates: [] },
  "sites/s42": { id: "s42", number: "42" },
  "sites/s24": { id: "s24", number: "24" },
  "cottages/k42": { id: "k42", name: "Cedar", siteId: "s42" },
  "cottages/k24": { id: "k24", name: "Pine", siteId: "s24" },
  "customers/c1": { id: "c1", name: "Robert Smith", email: "rsmith@x.com", phone: "(613) 555-1234", siteIds: ["s42"] },
  "customers/c2": { id: "c2", name: "Amy Lee", email: "amy@lee.ca", siteIds: ["s24"] },
  "workOrders/old": { id: "old", title: "Older job", status: "Completed", date: "2026-09-01", workOrderNumber: "WO-0041", partsUsed: [] }
};
beforeEach(async () => { await resetData(BASE); });
// Customers, sites, cottages, work orders and the sign-up have all loaded.
const READY = "(api) => api.db.customers.length === 2 && api.db.sites.length === 2 && api.db.cottages.length === 2 && api.db.workOrders.length === 1 && (api.pendingSignups || []).length === 1";

const viewFactory = (view, extra = "") => `(api) => React.createElement(${view}, { db: api.db, persist: api.persist, pendingSignups: api.pendingSignups, removePendingSignup: api.removePendingSignup, confirmPendingSignup: api.confirmPendingSignup, saveWorkOrder: api.saveWorkOrder, saveInvoice: api.saveInvoice, saveCorrespondence: api.saveCorrespondence, savePropaneRequest: api.savePropaneRequest, deletePropaneRequest: api.deletePropaneRequest, saveWinterizingRequest: api.saveWinterizingRequest, deleteWinterizingRequest: api.deleteWinterizingRequest, readOnly: false ${extra} })`;

test("A winterizing sign-up matched by phone + site is confirmed and the new email remembered", async () => {
  await resetData({ ...BASE, "pendingSignups/p1": { id: "p1", type: "winterizing", submittedName: "Bob Smith", submittedEmail: "bob.smith@gmail.com", submittedPhone: "613-555-1234", submittedSiteNumber: "Site #42", requestedDate: "2026-10-20", receivedAt: "2026-10-01T12:00:00Z", options: {} } });
  const page = await openApp(browser, "emulator", { role: "office" });
  await mountWithDb(page, viewFactory("WinterizingView"), READY);
  await page.getByRole("button", { name: "Review" }).first().click();
  await page.getByText("Matched by phone + site number match").waitFor();
  assert.ok(await page.getByText(/Remember bob\.smith@gmail\.com for Robert Smith/).isVisible());
  await page.getByRole("button", { name: "Confirm Sign-Up" }).click();
  const req = await waitFor(() => findIn("winterizingRequests", (r) => r.cottageId === "k42"), "the winterizing request");
  assert.equal(req.customerId, "c1");
  await waitFor(async () => (await readCollection("pendingSignups")).length === 0, "the pending sign-up to be removed");
  const customer = await waitFor(async () => { const c = await readDoc("customers/c1"); return (c.matchEmails || []).includes("bob.smith@gmail.com") ? c : null; }, "the email to be remembered");
  assert.ok(customer);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("A propane sign-up is confirmed into a propane request", async () => {
  await resetData({ ...BASE, "pendingSignups/p2": { id: "p2", type: "propane", submittedName: "Amy Lee", submittedEmail: "AMY@lee.ca", submittedSiteNumber: "24", requestedDate: "2026-10-21", receivedAt: "2026-10-01T12:00:00Z" } });
  const page = await openApp(browser, "emulator", { role: "office" });
  await mountWithDb(page, viewFactory("PropaneView"), READY);
  await page.getByRole("button", { name: "Review" }).first().click();
  await page.getByText("Matched by email + site number match").waitFor();
  await page.getByRole("button", { name: "Confirm Sign-Up" }).click();
  const req = await waitFor(() => findIn("propaneRequests", (r) => r.cottageId === "k24"), "the propane request");
  assert.equal(req.customerId, "c2");
  await waitFor(async () => (await readCollection("pendingSignups")).length === 0, "the pending sign-up to be removed");
  await page.close();
});

test("A general service request becomes a work order with the next number", async () => {
  await resetData({ ...BASE, "pendingSignups/p3": { id: "p3", type: "generalservice", submittedName: "Amy Lee", submittedEmail: "amy@lee.ca", submittedSiteNumber: "24", submittedDescription: "Leaky tap in the kitchen", submittedCategory: "Plumbing", receivedAt: "2026-10-01T12:00:00Z" } });
  const page = await openApp(browser, "emulator", { role: "office" });
  await mountWithDb(page, viewFactory("GeneralServiceView", ", onBackToDashboard: () => {}"), READY);
  await page.getByRole("button", { name: "Review" }).first().click();
  await page.getByRole("button", { name: "Create Work Order" }).last().click();
  const wo = await waitFor(() => findIn("workOrders", (w) => w.sourceType === "generalServiceRequest"), "the work order");
  assert.equal(wo.workOrderNumber, "WO-0042");
  assert.equal(wo.siteId, "s24");
  assert.equal(wo.customerId, "c2");
  assert.match(wo.description, /Leaky tap in the kitchen/);
  await waitFor(async () => (await readCollection("pendingSignups")).length === 0, "the pending sign-up to be removed");
  await page.close();
});
