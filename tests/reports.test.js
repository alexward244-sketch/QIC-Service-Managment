// Service Reports: every record type in the list opens when clicked.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readDoc, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

test("Propane, tree and quote rows in Service Reports open their record", async () => {
  await resetData({
    "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], workOrderTemplates: [], parts: [], userRoles: { "tester@qicampark.com": "manager" } },
    "sites/s1": { id: "s1", number: "42" },
    "cottages/k1": { id: "k1", name: "Maple Cottage", siteId: "s1" },
    "propaneRequests/p1": { id: "p1", cottageId: "k1", requestedDate: "2026-09-28", completed: false, payment: "Invoice" },
    "treeRequests/t1": { id: "t1", siteId: "s1", notedDate: "2026-09-27", stage: "To be Inspected", priority: "Medium", description: "Dead limb over the deck" },
    "quotes/q1": { id: "q1", title: "Deck repair", date: "2026-09-26", status: "Draft", siteId: "s1", lineItems: [{ id: "l1", description: "Boards", quantity: 4, unitPrice: 25 }], laborHours: 0, laborRateType: "N/A" }
  });
  const page = await openApp(browser, "emulator", { role: "manager" });
  await mountWithDb(page, `(r) => React.createElement(ServiceReportsView, { db: r.db, persist: r.persist, saveWinterizingRequest: r.saveWinterizingRequest, savePropaneRequest: r.savePropaneRequest, saveTreeRequest: r.saveTreeRequest, saveQuote: r.saveQuote, saveWorkOrder: r.saveWorkOrder, saveInvoice: r.saveInvoice, saveCorrespondence: r.saveCorrespondence, onCreateInvoice: () => {} })`,
    "(r) => r.db.propaneRequests.length === 1 && r.db.treeRequests.length === 1 && r.db.quotes.length === 1 && r.db.cottages.length === 1");

  await page.getByText("Propane — Maple Cottage").click();
  await page.getByText("Edit Propane Request").waitFor();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByText(/^Tree —/).click();
  await page.getByText("Edit Tree Entry").waitFor();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByText("Deck repair").click();
  await page.getByText("Edit Quote").waitFor();
  await page.getByRole("button", { name: "Save Quote" }).click();
  const log = await waitFor(async () => { const d = await readDoc("campground/data"); return (d.activityLog || []).find((e) => e.summary === "Updated quote \"Deck repair\""); }, "the quote edit to be logged");
  assert.ok(log);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
