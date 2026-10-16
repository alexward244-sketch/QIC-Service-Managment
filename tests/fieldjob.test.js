// The phone's job screen shows what the crew needs at the door: the
// customer's notes, the appliance the job is for (with its service visits),
// and the last few things done at the cottage.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, cleanup } = require("./helpers/emulator");
const { mountWithDb } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const noop = "() => {}";
const app = `(api) => React.createElement(CurrentUserContext.Provider, { value: "alex@x.com" }, React.createElement(FieldApp, { db: api.db, persist: api.persist, actor: "Mike", saveWorkOrder: api.saveWorkOrder, savePropaneRequest: api.savePropaneRequest, saveWinterizingRequest: api.saveWinterizingRequest, saveInvoice: api.saveInvoice, deleteInvoice: ${noop}, saveQuote: api.saveQuote, saveCottage: api.saveCottage, saveSite: api.saveSite, saveCorrespondence: api.saveCorrespondence, deleteCorrespondence: api.deleteCorrespondence, saveCustomer: api.saveCustomer, saveTreeRequest: api.saveTreeRequest, pendingSignups: [], confirmPendingSignup: ${noop}, removePendingSignup: ${noop}, isAdminOrManager: false, onCreateInvoice: ${noop}, onGoToDesktopTab: ${noop}, onSignOut: null }))`;

async function openJob(id) {
  const page = await openApp(browser, "emulator", { role: "office", email: "alex@x.com", viewport: { width: 390, height: 900 } });
  await page.evaluate((jobId) => window.history.replaceState({ qicField: { screen: "job", jobId, idx: 0 } }, ""), id);
  await mountWithDb(page, app, "(api) => api.db.workOrders.length >= 3 && api.db.cottages.length === 1 && api.db.customers.length === 1");
  return page;
}

test("a job shows the customer's notes, its appliance and the cottage's recent history", async () => {
  await resetData({
    "campground/data": { settings: {}, activityLog: [], staff: [], parts: [], workOrderTemplates: [] },
    "sites/a": { id: "a", number: "1051" },
    "customers/c1": { id: "c1", name: "Robert & Linda Smith", siteIds: ["a"], notes: "Gate code 4421. Dog inside - call first." },
    "cottages/k1": { id: "k1", name: "Loon", siteId: "a", appliances: [{ id: "ap1", type: "Furnace", make: "Suburban", model: "P-40", year: "2009", serialNumber: "190707005", serviceLog: [{ id: "l1", date: "2026-09-12", description: "Annual furnace check" }, { id: "l2", date: "2025-09-10", description: "Cleaned burner" }] }] },
    "workOrders/w1": { id: "w1", workOrderNumber: "WO-0441", title: "Furnace clicking", status: "Open", siteId: "a", cottageId: "k1", customerId: "c1", applianceId: "ap1", date: "2026-10-16", notes: [], partsUsed: [] },
    "workOrders/w0": { id: "w0", workOrderNumber: "WO-0431", title: "Annual furnace check", status: "Completed", siteId: "a", cottageId: "k1", customerId: "c1", date: "2026-09-12", completedDate: "2026-09-12", notes: [], partsUsed: [] },
    "workOrders/w2": { id: "w2", workOrderNumber: "WO-0440", title: "Deck board loose", status: "In Progress", siteId: "a", cottageId: "k1", customerId: "c1", date: "2026-10-07", notes: [], partsUsed: [] },
    "winterizingRequests/r1": { id: "r1", cottageId: "k1", requestedDate: "2026-10-06", completed: true, completedDate: "2026-10-06" }
  });
  const page = await openJob("w1");
  await page.locator("[data-job-customer-notes]").getByText("Gate code 4421. Dog inside - call first.").waitFor();
  const appl = page.locator("[data-job-appliance]");
  await appl.getByText("Suburban P-40").waitFor();
  await appl.getByText("190707005").waitFor();
  await appl.getByText("Annual furnace check").waitFor();
  const hist = await page.locator("[data-job-history]").innerText();
  assert.match(hist, /Last time we were here/);
  assert.match(hist, /WO-0440 · Deck board loose — In Progress/);
  assert.match(hist, /Winterized/);
  assert.match(hist, /WO-0431 · Annual furnace check/);
  assert.doesNotMatch(hist, /WO-0441/, "not the job itself");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
