// Work order flows, driven through the real screens against the Firestore
// emulator with the real firestore.rules. The first test is the one that
// would have caught the Sep 26-30 bug (New Work Order on the Work Orders tab
// didn't save).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readCollection, readDoc, cleanup } = require("./helpers/emulator");
const { mountWithDb } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const SETTINGS = { settings: { taxRate: 13 }, activityLog: [], staff: [{ id: "st1", name: "Dave" }], workOrderTemplates: [], parts: [{ id: "p1", name: "Washer", price: 2, quantity: 10 }], userRoles: { "tester@qicampark.com": "admin" } };
beforeEach(async () => {
  await resetData({
    "campground/data": SETTINGS,
    "sites/s1": { id: "s1", number: "42" },
    "workOrders/old": { id: "old", title: "Older job", status: "Open", priority: "Medium", date: "2026-09-01", workOrderNumber: "WO-0041", partsUsed: [] }
  });
});

// Renders the Work Orders tab with the app's own data layer (useDb).
async function openWorkOrdersTab(role) {
  const page = await openApp(browser, "emulator", { role });
  await mountWithDb(page, `(r) => React.createElement(WorkOrdersView, { db: r.db, persist: r.persist, saveWorkOrder: r.saveWorkOrder, deleteWorkOrder: r.deleteWorkOrder, saveCottage: () => {}, saveCorrespondence: () => {}, onCreateInvoice: () => {}, workOrderPrefill: null, onConsumeWorkOrderPrefill: () => {} })`, "(r) => r.db.workOrders.length >= 1");
  await page.getByRole("button", { name: "New Work Order" }).first().waitFor({ timeout: 20000 });
  return page;
}

async function waitFor(check, what, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const findWorkOrder = async (title) => (await readCollection("workOrders")).find((w) => w.title === title);

test("New Work Order on the Work Orders tab saves, with the next number", async () => {
  const page = await openWorkOrdersTab("admin");
  await page.getByRole("button", { name: "New Work Order" }).first().click();
  await page.getByPlaceholder("e.g. Fix leaking faucet").fill("Gas test");
  await page.getByRole("button", { name: "Save Work Order" }).click();
  const wo = await waitFor(() => findWorkOrder("Gas test"), "the new work order to be saved");
  assert.equal(wo.workOrderNumber, "WO-0042");
  assert.equal(wo.status, "Open");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("Office staff can create work orders under the real rules", async () => {
  const page = await openWorkOrdersTab("office");
  await page.getByRole("button", { name: "New Work Order" }).first().click();
  await page.getByPlaceholder("e.g. Fix leaking faucet").fill("Office job");
  await page.getByRole("button", { name: "Save Work Order" }).click();
  await waitFor(() => findWorkOrder("Office job"), "the office user's work order");
  await page.close();
});

test("A failed save keeps the form open and shows the error instead of 'created'", async () => {
  const page = await openWorkOrdersTab("admin");
  await page.evaluate(() => {
    const proto = Object.getPrototypeOf(WORK_ORDERS_REF.doc("x"));
    const realSet = proto.set;
    proto.set = function (data, opts) {
      if (this.parent && this.parent.id === "workOrders") return Promise.reject(Object.assign(new Error("Simulated failure"), { code: "unavailable" }));
      return realSet.call(this, data, opts);
    };
  });
  await page.getByRole("button", { name: "New Work Order" }).first().click();
  await page.getByPlaceholder("e.g. Fix leaking faucet").fill("Won't save");
  await page.getByRole("button", { name: "Save Work Order" }).click();
  await page.locator("#save-error").waitFor();
  assert.match(await page.locator("#save-error").textContent(), /Couldn't save that work order/);
  assert.ok(await page.getByRole("button", { name: "Save Work Order" }).isVisible(), "the form should stay open");
  assert.equal(await page.getByText("Work order created").count(), 0);
  assert.equal(await findWorkOrder("Won't save"), undefined);
  await page.close();
});

test("Completing through the wrap-up window saves hours, service call and parts and deducts stock", async () => {
  await resetData({
    "campground/data": SETTINGS,
    "workOrders/w1": { id: "w1", title: "Leaky tap", status: "In Progress", priority: "Medium", date: "2026-09-30", workOrderNumber: "WO-0050", assignedTo: "Dave", partsUsed: [{ partId: "p1", quantity: 1 }], notes: [] }
  });
  const page = await openWorkOrdersTab("admin");
  await page.getByRole("button", { name: /^In Progress/ }).click();
  await page.getByRole("button", { name: "Complete →" }).click();
  await page.getByText("Wrap up: Leaky tap").waitFor();
  await page.getByLabel("Hours", { exact: true }).first().fill("2");
  await page.getByRole("button", { name: "+ Add another worker" }).click();
  await page.getByLabel("Worker", { exact: true }).nth(1).fill("Mike");
  await page.getByLabel("Hours", { exact: true }).nth(1).fill("1.5");
  await page.getByLabel(/^Service call/).selectOption("Tech");
  await page.getByPlaceholder(/Replaced kitchen faucet/).fill("Swapped the washer");
  await page.getByRole("button", { name: "Save & Complete" }).click();
  const wo = await waitFor(async () => { const w = await findWorkOrder("Leaky tap"); return w && w.status === "Completed" ? w : null; }, "the work order to be completed");
  assert.equal(wo.laborHours, 3.5);
  assert.deepEqual(wo.laborEntries.map((e) => [e.name, e.hours]), [["Dave", 2], ["Mike", 1.5]]);
  assert.equal(wo.serviceCallType, "Tech");
  const last = wo.statusHistory[wo.statusHistory.length - 1];
  assert.deepEqual([last.from, last.status], ["In Progress", "Completed"], "the status change is recorded on the work order");
  assert.ok(last.by && last.at);
  assert.equal(wo.serviceCall, 70);
  assert.ok(wo.completedDate);
  assert.equal(wo.notes[0].text, "Work done: Swapped the washer");
  const stock = await waitFor(async () => { const d = await readDoc("campground/data"); const p = d.parts.find((x) => x.id === "p1"); return p.quantity === 9 ? p : null; }, "stock to be deducted");
  assert.equal(stock.quantity, 9);
  await page.close();
});

test("The dashboard's New Work Order window saves, with the next number", async () => {
  const page = await openApp(browser, "emulator", { role: "admin" });
  await mountWithDb(page, `(r) => React.createElement(QuickWorkOrderModal, { db: r.db, initial: null, saveWorkOrder: r.saveWorkOrder, onClose: () => {} })`, "(r) => r.db.workOrders.length >= 1");
  await page.getByPlaceholder("e.g. Fix leaking faucet").fill("From the dashboard", { timeout: 20000 });
  await page.getByRole("button", { name: "Save Work Order" }).click();
  const wo = await waitFor(() => findWorkOrder("From the dashboard"), "the dashboard work order");
  assert.equal(wo.workOrderNumber, "WO-0042");
  await page.close();
});

test("An account without a role can't read or save work orders", async () => {
  const page = await openApp(browser, "emulator", { role: "" });
  const result = await page.evaluate(async () => {
    const out = {};
    try { await WORK_ORDERS_REF.get({ source: "server" }); out.read = "allowed"; } catch (e) { out.read = e.code; }
    try { await WORK_ORDERS_REF.doc("sneaky").set({ id: "sneaky", title: "x" }); out.write = "allowed"; } catch (e) { out.write = e.code; }
    return out;
  });
  assert.equal(result.read, "permission-denied");
  assert.equal(result.write, "permission-denied");
  await page.close();
});

test("Every status change is recorded on the work order, including a reopen", async () => {
  await resetData({
    "campground/data": SETTINGS,
    "workOrders/w1": { id: "w1", title: "Sunroom caulking", status: "Completed", completedDate: "2026-09-10", priority: "Medium", date: "2026-09-05", workOrderNumber: "WO-0009", partsUsed: [], notes: [] }
  });
  const page = await openApp(browser, "emulator", { role: "admin" });
  await mountWithDb(page, `(r) => React.createElement(CurrentUserContext.Provider, { value: "tester@qicampark.com" }, React.createElement(WorkOrdersView, { db: r.db, persist: r.persist, saveWorkOrder: r.saveWorkOrder, deleteWorkOrder: r.deleteWorkOrder, saveCottage: () => {}, saveCorrespondence: () => {}, onCreateInvoice: () => {}, workOrderPrefill: null, onConsumeWorkOrderPrefill: () => {} }))`, "(r) => r.db.workOrders.length === 1");
  await page.evaluate(() => { const w = window.__api.db.workOrders[0]; return window.__api.saveWorkOrder({ ...w, status: "Open", completedDate: null }); });
  const wo = await waitFor(async () => { const w = await findWorkOrder("Sunroom caulking"); return w && w.status === "Open" ? w : null; }, "the reopen to save");
  assert.equal(wo.statusHistory.length, 1);
  assert.deepEqual([wo.statusHistory[0].from, wo.statusHistory[0].status, wo.statusHistory[0].by], ["Completed", "Open", "tester@qicampark.com"]);
  // A save that doesn't change the status adds nothing.
  await page.evaluate(() => { const w = window.__api.db.workOrders[0]; return window.__api.saveWorkOrder({ ...w, notes: [{ id: "n", text: "hi" }] }); });
  const again = await waitFor(async () => { const w = await findWorkOrder("Sunroom caulking"); return w && w.notes.length ? w : null; }, "the note to save");
  assert.equal(again.statusHistory.length, 1);
  await page.close();
});

test("Work orders and invoices keep the time they were created (for the correspondence timeline)", async () => {
  await resetData({
    "campground/data": SETTINGS,
    "workOrders/old": { id: "old", title: "Older job", status: "Open", priority: "Medium", date: "2026-09-01", workOrderNumber: "WO-0041", partsUsed: [] },
    "invoices/i-old": { id: "i-old", invoiceNumber: "INV-0001", date: "2026-09-02", sentDate: "2026-09-02", lineItems: [], notes: "" }
  });
  const page = await openApp(browser, "emulator", { role: "office" });
  await mountWithDb(page, "(r) => React.createElement('div', null, 'ready')", "(r) => r.db.workOrders.length === 1 && r.db.invoices.length === 1");
  await page.evaluate(() => window.__api.saveWorkOrder({ id: "n1", title: "New job", status: "Open", priority: "Medium", date: "2026-10-05", partsUsed: [] }));
  const created = await waitFor(() => findWorkOrder("New job"), "the new work order");
  assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  // An edit that doesn't carry createdAt (as the form's doesn't) keeps it;
  // an older work order that never had one doesn't get one.
  await waitFor(() => page.evaluate(() => window.__api.db.workOrders.some((w) => w.id === "n1")), "the new work order to load");
  await page.evaluate(() => window.__api.saveWorkOrder({ id: "n1", title: "New job (edited)", status: "Open", priority: "Medium", date: "2026-10-05", partsUsed: [] }));
  await page.evaluate(() => { const w = window.__api.db.workOrders.find((x) => x.id === "old"); return window.__api.saveWorkOrder({ ...w, title: "Older job (edited)" }); });
  const edited = await waitFor(() => findWorkOrder("New job (edited)"), "the edit");
  assert.equal(edited.createdAt, created.createdAt);
  const old = await waitFor(() => findWorkOrder("Older job (edited)"), "the older edit");
  assert.equal(old.createdAt, undefined);
  // Office staff may only change an invoice's notes: adding one to an older
  // invoice must not slip in the new time fields.
  const ok = await page.evaluate(() => { const i = window.__api.db.invoices[0]; return window.__api.saveInvoice({ ...i, notes: "Customer called" }); });
  assert.equal(ok, true);
  const inv = await readDoc("invoices/i-old");
  assert.equal(inv.notes, "Customer called");
  assert.equal(inv.createdAt, undefined);
  assert.equal(inv.sentAt, undefined);
  await page.close();
});

test("The board shows one status at a time with Open / In Progress / Completed pills", async () => {
  await resetData({
    "campground/data": SETTINGS,
    "workOrders/o1": { id: "o1", title: "Open job A", status: "Open", priority: "Medium", date: "2026-09-30", workOrderNumber: "WO-0001", partsUsed: [], notes: [] },
    "workOrders/o2": { id: "o2", title: "Open job B", status: "Open", priority: "Medium", date: "2026-09-29", workOrderNumber: "WO-0002", partsUsed: [], notes: [] },
    "workOrders/p1": { id: "p1", title: "Started job", status: "In Progress", priority: "Medium", date: "2026-09-28", workOrderNumber: "WO-0003", partsUsed: [], notes: [] },
    "workOrders/c1": { id: "c1", title: "Finished job", status: "Completed", completedDate: "2026-09-27", priority: "Medium", date: "2026-09-27", workOrderNumber: "WO-0004", partsUsed: [], notes: [] },
    "workOrders/c2": { id: "c2", title: "Archived job", status: "Completed", archived: true, completedDate: "2026-09-01", priority: "Medium", date: "2026-09-01", workOrderNumber: "WO-0005", partsUsed: [], notes: [] }
  });
  const page = await openWorkOrdersTab("admin");
  const pill = (name) => page.getByRole("button", { name: new RegExp(`^${name}\\s*\\d+$`) });
  // Counts on the pills; archived jobs aren't counted.
  assert.equal((await pill("Open").textContent()).replace(/\s+/g, " "), "Open2");
  assert.equal(await pill("In Progress").textContent(), "In Progress1");
  assert.equal(await pill("Completed").textContent(), "Completed1");
  // Open by default: only open jobs show.
  await page.getByText("Open job A").waitFor();
  assert.equal(await page.getByText("Started job").count(), 0);
  await pill("Completed").click();
  await page.getByText("Finished job").waitFor();
  assert.equal(await page.getByText("Open job A").count(), 0);
  // A search looks through every status.
  await page.getByPlaceholder("Search work orders\u2026").fill("job");
  await page.getByText("4 matches across all statuses").waitFor();
  await page.getByText("Started job").waitFor();
  await page.getByPlaceholder("Search work orders\u2026").fill("");
  // Dropping a job on a pill moves it there.
  await pill("Open").click();
  await page.getByText("Open job B").dragTo(pill("In Progress"));
  await waitFor(async () => { const w = await findWorkOrder("Open job B"); return w && w.status === "In Progress"; }, "the dropped job to move");
  // The chosen pill is remembered.
  await pill("Completed").click();
  assert.equal(await page.evaluate(() => localStorage.getItem("qic-wo-status-tab")), "Completed");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
