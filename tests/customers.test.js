// Customers tab: the table with filters for what needs doing, and the
// customer's full page - history (clickable, filterable), the reply box
// under an email waiting for an answer, notes, and hydro bills for office.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readDoc, readCollection, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const EMAIL = "reserve@qicampark.com";
const seed = (role = "office") => resetData({
  "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], parts: [], workOrderTemplates: [], cannedReplies: [{ id: "cr1", title: "Thanks", body: "Thanks, we'll be in touch." }], userRoles: { [EMAIL]: role } },
  "sites/a": { id: "a", number: "1051", section: "Pebble Beach", tags: [] },
  "sites/b": { id: "b", number: "0020", section: "Front of Park", tags: [] },
  "cottages/k1": { id: "k1", name: "Loon", siteId: "a", serialNumber: "2165117532", modelNumber: "SW.16-4513-3Y", year: "2016" },
  "customers/c1": { id: "c1", name: "Robert & Linda Smith", phone: "6135550148", email: "rob@x.com", siteIds: ["a"], siteId: "a" },
  "customers/c2": { id: "c2", name: "Ann Lee", phone: "6135550199", siteIds: ["b"], siteId: "b" },
  "correspondence/m1": { id: "m1", direction: "in", status: "new", customerId: "c1", fromEmail: "rob@x.com", fromName: "Linda Smith", subject: "Furnace noise", body: "The furnace is clicking again. Can someone look before the weekend?", receivedAt: "2026-10-09T13:14:00Z" },
  "correspondence/m0": { id: "m0", direction: "in", status: "handled", customerId: "c1", fromEmail: "rob@x.com", subject: "Water on the floor", body: "By the tank", receivedAt: "2026-08-12T12:00:00Z" },
  "workOrders/w1": { id: "w1", workOrderNumber: "WO-0440", title: "Deck board loose", status: "Open", siteId: "a", cottageId: "k1", customerId: "c1", date: "2026-10-07", notes: [], partsUsed: [] },
  "invoices/i1": { id: "i1", invoiceNumber: "INV-26-0088", title: "Hot water tank", date: "2026-08-15", sourceType: "workOrder", sourceId: "w0", customerId: "c1", siteId: "a", lineItems: [{ id: "l", description: "Tank", quantity: 1, unitPrice: 500 }], taxRate: 13 },
  "hydroReadings/h1": { id: "h1", siteId: "a", ownerAtReading: "c1", status: "invoiced", invoiceNumber: "HYD-26-0214", invoicedAt: "2026-08-31", date: "2026-08-31", previousReading: 10866, reading: 12106, usage: 1240, amount: 198.4, taxAmount: 22.8 }
});
const view = `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(CustomersView, { db: api.db, persist: api.persist, saveCustomer: api.saveCustomer, deleteCustomer: api.deleteCustomer, saveWorkOrder: api.saveWorkOrder, saveQuote: null, saveInvoice: null, saveCorrespondence: api.saveCorrespondence, saveCottage: api.saveCottage, saveSite: api.saveSite, canTransfer: false, filterPrefill: null }))`;
const READY = "(api) => api.db.customers.length === 2 && api.db.correspondence.length >= 2";

test("the table's filters find who needs a reply, has open work or no email, and by area", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await mountWithDb(page, view, READY);
  const rows = () => page.locator("tbody tr").count();
  assert.equal(await rows(), 2);
  await page.getByRole("button", { name: "Needs a reply (1)" }).click();
  assert.equal(await rows(), 1);
  await page.getByRole("button", { name: "Robert & Linda Smith" }).waitFor();
  await page.getByRole("button", { name: "No email on file (1)" }).click();
  await page.getByRole("button", { name: "Ann Lee" }).waitFor();
  await page.getByRole("button", { name: "Front of Park" }).click();
  assert.equal(await rows(), 1);
  await page.getByRole("button", { name: "Open work orders (1)" }).click();
  await page.getByRole("button", { name: "Robert & Linda Smith" }).click();
  // The full page; back keeps the filter.
  await page.getByRole("heading", { name: "Robert & Linda Smith" }).waitFor();
  await page.getByText("1 unanswered email · 1 open work order").waitFor();
  await page.getByRole("button", { name: "← All customers" }).click();
  assert.equal(await page.getByRole("button", { name: "Open work orders (1)" }).getAttribute("class").then((c) => c.includes("bg-[#377249]")), true);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("replying under a waiting email sends it and marks it answered; notes save", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await page.evaluate(() => { window.__sent = []; window.sendEmail = async (m) => { window.__sent.push(m); return { ok: true }; }; });
  await mountWithDb(page, view, READY);
  await page.getByRole("button", { name: "Robert & Linda Smith" }).click();
  await page.getByText("The furnace is clicking again.", { exact: false }).waitFor();
  await page.locator("textarea").first().waitFor();
  const box = page.locator('[data-history="c-m1"] textarea');
  await box.fill("Hi Linda, we'll check it Thursday.");
  await page.locator('[data-history="c-m1"]').getByRole("button", { name: /^Send/ }).click();
  await waitFor(async () => (await readDoc("correspondence/m1")).status === "handled", "the email to be marked answered");
  const sent = await page.evaluate(() => window.__sent);
  assert.equal(sent[0].toEmail, "rob@x.com");
  assert.match(sent[0].subject, /^Re: Furnace noise/);
  const out = (await readCollection("correspondence")).find((c) => c.direction === "out");
  assert.equal(out.customerId, "c1");
  // Notes.
  await page.getByLabel("Customer notes").fill("Call before going in. Dog on site.");
  await page.getByRole("button", { name: "Save note" }).click();
  await waitFor(async () => (await readDoc("customers/c1")).notes === "Call before going in. Dog on site.", "the note to save");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("history: filter to bills, open a hydro bill to print, open a work order", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await mountWithDb(page, view, READY);
  await page.getByRole("button", { name: "Robert & Linda Smith" }).click();
  await page.getByRole("button", { name: "Bills & invoices" }).click();
  // Both load on their own (hydro readings and invoices are separate collections).
  await page.locator('[data-history="h-h1"]').waitFor();
  await page.locator('[data-history="i-i1"]').waitFor();
  assert.equal(await page.locator("[data-history]").count(), 2, "the hydro bill and the invoice");
  await page.locator('[data-history="h-h1"] button').click();
  await page.locator('[data-hydro-bill-view="h1"]').waitFor();
  await page.getByRole("button", { name: "Print" }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.locator('[data-history="i-i1"] button').click();
  await page.locator("[data-document-view]").waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit invoice" }).count(), 0, "office can view and print, not edit");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await page.locator('[data-history="w-w1"] button').click();
  await page.getByText("Deck board loose").last().waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
