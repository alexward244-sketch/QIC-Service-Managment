// Creating an invoice from a completed work order: parts become line items,
// hours become the labour charge, and the customer summary becomes the notes.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor, findIn } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

for (const role of ["admin", "accounting"]) {
  test(`An invoice created from a completed work order carries its parts, hours and summary (${role})`, async () => {
    await resetData({
      "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], workOrderTemplates: [], parts: [{ id: "p1", name: "Washer", price: 20, quantity: 5 }] },
      "sites/s1": { id: "s1", number: "42" },
      "customers/c1": { id: "c1", name: "Robert Smith", email: "rsmith@x.com", siteIds: ["s1"] },
      "workOrders/w1": { id: "w1", title: "Leaky tap", status: "Completed", completedDate: "2026-09-30", date: "2026-09-30", workOrderNumber: "WO-0050", siteId: "s1", customerId: "c1", partsUsed: [{ partId: "p1", quantity: 2 }], laborHours: 1.5, laborRateType: "Labour Tech", laborEntries: [{ id: "a", name: "Dave", hours: 1 }, { id: "b", name: "Mike", hours: 0.5 }], customerSummary: "We replaced the kitchen tap washer." }
    });
    const page = await openApp(browser, "emulator", { role });
    await mountWithDb(page, `(api) => {
      if (window.__prefill === undefined) { const wo = (api.db.workOrders || []).find((w) => w.id === "w1"); window.__prefill = wo ? { source: wo, sourceType: "workOrder" } : undefined; }
      return React.createElement(InvoicesView, { db: api.db, persist: api.persist, saveInvoice: api.saveInvoice, deleteInvoice: api.deleteInvoice, saveWorkOrder: api.saveWorkOrder, saveCorrespondence: api.saveCorrespondence, invoicePrefill: window.__prefill || null, onConsumeInvoicePrefill: () => { window.__prefill = null; } });
    }`, "(api) => api.db.workOrders.length === 1 && api.db.customers.length === 1 && api.db.sites.length === 1");
    await page.getByRole("button", { name: "Save Invoice" }).click({ timeout: 20000 });
    const inv = await waitFor(() => findIn("invoices", (i) => i.sourceId === "w1"), "the invoice");
    assert.equal(inv.sourceType, "workOrder");
    assert.equal(inv.customerId, "c1");
    assert.equal(inv.notes, "We replaced the kitchen tap washer.");
    assert.equal(inv.laborHours, 1.5, "the invoice carries the total hours only");
    assert.equal(inv.laborEntries, undefined, "the per-worker breakdown stays on the work order");
    assert.deepEqual(inv.lineItems.map((l) => [l.description, l.quantity, l.unitPrice]), [["Washer", 2, 20]]);
    assert.ok(inv.invoiceNumber, "the invoice has a number");
    assert.deepEqual(page.pageErrors, []);
    await page.close();
  });
}
