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
  test(`An invoice created from a completed work order carries its parts, hours, service call and summary (${role})`, async () => {
    await resetData({
      "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], workOrderTemplates: [], parts: [{ id: "p1", name: "Washer", price: 20, quantity: 5 }] },
      "sites/s1": { id: "s1", number: "42" },
      "customers/c1": { id: "c1", name: "Robert Smith", email: "rsmith@x.com", siteIds: ["s1"] },
      "workOrders/w1": { id: "w1", title: "Leaky tap", status: "Completed", completedDate: "2026-09-30", date: "2026-09-30", workOrderNumber: "WO-0050", siteId: "s1", customerId: "c1", partsUsed: [{ partId: "p1", quantity: 2 }], laborHours: 1.5, laborRateType: "Labour Tech", laborEntries: [{ id: "a", name: "Dave", hours: 1 }, { id: "b", name: "Mike", hours: 0.5 }], serviceCallType: "Tech", serviceCall: 70, customerSummary: "We replaced the kitchen tap washer." }
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
    assert.equal(inv.serviceCallType, "Tech", "the service call picked at wrap-up carries over");
    assert.equal(inv.serviceCall, 70);
    assert.deepEqual(inv.lineItems.map((l) => [l.description, l.quantity, l.unitPrice]), [["Washer", 2, 20]]);
    assert.ok(inv.invoiceNumber, "the invoice has a number");
    assert.deepEqual(page.pageErrors, []);
    await page.close();
  });
}

test("Invoices: the email column keeps where it was sent (or why it didn't send), and the checkmark records how it was paid", async () => {
  await resetData({
    "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], workOrderTemplates: [], parts: [] },
    "customers/c1": { id: "c1", name: "Robert Smith", email: "rsmith@x.com", siteIds: [] },
    "invoices/i1": { id: "i1", invoiceNumber: "INV-26-0001", customerId: "c1", date: "2026-10-01", lineItems: [{ id: "l1", description: "Washer", quantity: 1, unitPrice: 100 }], laborHours: 0, laborRate: 0, taxRate: 13, depositAmount: 0 }
  });
  const page = await openApp(browser, "emulator", { role: "admin" });
  await page.evaluate(() => { window.__sent = []; window.sendEmail = async (e) => { window.__sent.push(e.toEmail); return {}; }; });
  await mountWithDb(page, `(api) => React.createElement(InvoicesView, { db: api.db, persist: api.persist, saveInvoice: api.saveInvoice, deleteInvoice: api.deleteInvoice, saveWorkOrder: api.saveWorkOrder, saveCorrespondence: api.saveCorrespondence })`, "(api) => api.db.invoices.length === 1 && api.db.customers.length === 1");
  const row = page.locator("tr", { hasText: "INV-26-0001" });
  await row.getByText("Not sent").waitFor({ timeout: 20000 });
  assert.equal(await page.getByRole("columnheader", { name: "Status" }).count(), 0, "no Status column");

  // Sent: says where, and stays.
  await row.getByRole("button", { name: "Email" }).click();
  await page.getByRole("button", { name: "Yes, send" }).click();
  await row.getByText("✓ Sent to rsmith@x.com").waitFor();
  let inv = await waitFor(() => findIn("invoices", (i) => i.id === "i1" && i.emailStatus === "sent"), "the sent invoice");
  assert.equal(inv.emailedTo, "rsmith@x.com");
  assert.ok(inv.sentDate);
  await page.waitForTimeout(3500);
  assert.equal(await row.getByText("✓ Sent to rsmith@x.com").count(), 1, "the confirmation doesn't go away");

  // Didn't send: says so, with the reason, until it's sent again.
  await page.evaluate(() => { window.sendEmail = async () => { throw new Error("Mailbox unavailable"); }; });
  await row.getByRole("button", { name: "Resend" }).click();
  await page.getByRole("button", { name: "Yes, send" }).click();
  await row.getByText("✕ Didn't send to rsmith@x.com").waitFor();
  await row.getByText(/Mailbox unavailable/).waitFor();
  inv = await waitFor(() => findIn("invoices", (i) => i.id === "i1" && i.emailStatus === "failed"), "the failed send");
  assert.equal(inv.emailError, "Mailbox unavailable");
  assert.ok(await row.getByRole("button", { name: "Try again" }).count());

  // Paid: the checkmark, with how it was paid (Cash and Accounting are options); and back to not paid.
  assert.equal(await row.getByRole("button", { name: "Mark Paid in Full" }).count(), 0);
  await row.getByTitle("Mark as paid").click();
  assert.equal(await row.getByRole("button", { name: "Accounting" }).count(), 1);
  assert.equal(await row.getByRole("button", { name: "Store" }).count(), 0, "Square is the store");
  await row.getByRole("button", { name: "Cash" }).click();
  await row.getByText("Paid — Cash").waitFor();
  inv = await waitFor(() => findIn("invoices", (i) => i.id === "i1" && i.paidMethod === "Cash"), "the paid invoice");
  assert.equal(inv.depositAmount, 113);
  assert.ok(inv.paidInFullDate);
  await row.getByTitle("Paid — Cash").click();
  await row.getByRole("button", { name: "Not paid" }).click();
  inv = await waitFor(() => findIn("invoices", (i) => i.id === "i1" && !i.paidMethod), "the unpaid invoice");
  assert.equal(inv.depositAmount, 0);
  assert.equal(inv.paidInFullDate, null);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
