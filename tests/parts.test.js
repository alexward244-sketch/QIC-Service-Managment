// Parts live one per document in the parts collection, so a save writes
// only the parts it changed: an out-of-date copy on another device (a
// phone that lost signal) can't wipe everyone's part edits - SKUs went
// missing that way - and stock used on two devices at once both counts.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readCollection, readDoc, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const EMAIL = "tester@qicampark.com";
const MAIN = {
  settings: { taxRate: 13 }, activityLog: [], staff: [], workOrderTemplates: [], trash: [],
  userRoles: { [EMAIL]: "admin" },
  parts: [{ id: "p1", name: "Washer", price: 2, quantity: 10, trackQuantity: true }, { id: "p2", name: "Sealant", price: 18.21, quantity: 5, trackQuantity: true }]
};
const partsInCollection = async () => Object.fromEntries((await readCollection("parts")).map((p) => [p.id, p]));

test("Parts move from the shared record into their own collection on first load", async () => {
  await resetData({ "campground/data": MAIN });
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await mountWithDb(page, `(api) => React.createElement(PartsView, { db: api.db, persist: api.persist })`, `(api) => api.db.parts.length === 2`);
  const moved = await waitFor(async () => { const d = await readDoc("campground/data"); return d.parts === undefined ? await partsInCollection() : null; }, "the parts to be moved");
  assert.deepEqual(Object.keys(moved).sort(), ["p1", "p2"]);
  assert.equal(moved.p2.name, "Sealant");
  await page.getByText("Sealant").first().waitFor();
  await page.close();
});

test("An out-of-date copy saving later can't wipe a SKU, and stock used on two devices both counts", async () => {
  await resetData({ "campground/data": { ...MAIN, parts: [] }, "parts/p1": MAIN.parts[0], "parts/p2": MAIN.parts[1] });
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await mountWithDb(page, `(api) => React.createElement(PartsView, { db: api.db, persist: api.persist })`, `(api) => api.db.parts.length === 2`);
  // A second device's copy, taken now - before the SKU is added.
  await page.evaluate(() => { window.__stale = window.__api.db; });
  await page.locator("tr", { hasText: "Washer" }).getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByPlaceholder("e.g. WH-1001").fill("WSH-10");
  await page.getByRole("button", { name: /Save/ }).first().click();
  await waitFor(async () => (await partsInCollection()).p1.sku === "WSH-10", "the SKU to save");
  // The stale device now saves: once an activity line, then stock used on
  // two jobs (1 and 2 washers) from that same old copy.
  await page.evaluate(async () => {
    const stale = window.__stale;
    await window.__api.persist({ ...stale, activityLog: [{ id: "x", ts: new Date().toISOString(), actor: "Phone", summary: "Old copy saved" }] });
    await window.__api.persist({ ...stale, parts: deductPartsUsed(stale.parts, [{ partId: "p1", quantity: 1 }]) });
    await window.__api.persist({ ...stale, parts: deductPartsUsed(stale.parts, [{ partId: "p1", quantity: 2 }]) });
  });
  const p1 = await waitFor(async () => { const p = (await partsInCollection()).p1; return p.quantity === 7 ? p : null; }, "both stock changes");
  assert.equal(p1.sku, "WSH-10", "the SKU survives the old copy's saves");
  assert.equal(p1.quantity, 7, "10 - 1 - 2: both uses counted");
  assert.equal((await readDoc("campground/data")).parts, undefined, "parts are never written back into the shared record");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("Deleting a part moves it to Trash and removes its document; restoring brings it back", async () => {
  await resetData({ "campground/data": { ...MAIN, parts: [] }, "parts/p1": MAIN.parts[0], "parts/p2": MAIN.parts[1] });
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await mountWithDb(page, `(api) => React.createElement(PartsView, { db: api.db, persist: api.persist })`, `(api) => api.db.parts.length === 2`);
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await page.getByRole("button", { name: /^(Delete|Move to Trash|Yes)/ }).last().click();
  await waitFor(async () => Object.keys(await partsInCollection()).length === 1, "the part to be removed");
  const trash = (await readDoc("campground/data")).trash;
  assert.equal(trash.length, 1);
  await page.evaluate(async () => {
    const db = window.__api.db;
    await window.__api.persist(restoreTrashItem(db, db.trash[0].id));
  });
  await waitFor(async () => Object.keys(await partsInCollection()).length === 2, "the part to be restored");
  await page.close();
});
