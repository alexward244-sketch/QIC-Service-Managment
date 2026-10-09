// Cottage serial numbers (the cottage's "VIN"): the Missing serial # filter
// and quick-add, the duplicate check, and ownership history surviving a
// rename.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readDoc, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const EMAIL = "tester@qicampark.com";
const seed = () => resetData({
  "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], parts: [], workOrderTemplates: [], userRoles: { [EMAIL]: "admin" } },
  "sites/a": { id: "a", number: "0101", section: "Limestone South", tags: [], transferHistory: [{ id: "t1", date: "2024-05-01", fromCustomerName: "Old Owner", toCustomerName: "Robert Smith", cottageName: "Loon" }] },
  "sites/b": { id: "b", number: "0102", section: "Limestone South", tags: [] },
  "cottages/k1": { id: "k1", name: "Loon", siteId: "a", serialNumber: "" },
  "cottages/k2": { id: "k2", name: "Heron", siteId: "b", serialNumber: "AB-1234" },
  "cottages/k3": { id: "k3", name: "Osprey", siteId: null },
  "customers/c1": { id: "c1", name: "Robert Smith", siteIds: ["a"] }
});
const cottagesView = `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(CottagesView, { db: api.db, persist: api.persist, saveWorkOrder: api.saveWorkOrder, saveCustomer: api.saveCustomer, saveCottage: api.saveCottage, deleteCottage: api.deleteCottage, saveSite: api.saveSite, saveCorrespondence: api.saveCorrespondence, readOnly: false, canTransfer: true, filterPrefill: null }))`;
const READY = "(api) => api.db.cottages.length === 3 && api.db.sites.length === 2";

test("Missing serial # lists cottages without one, and a serial can be typed straight in", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await mountWithDb(page, cottagesView, READY);
  await page.getByRole("button", { name: "Missing serial # (2)" }).click();
  await page.getByText("1 of 3 cottages have a serial number.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Heron" }).count(), 0, "Heron has a serial, so it's hidden");

  // Same number written differently is caught as a duplicate.
  const loon = page.getByLabel("Serial number for Loon");
  await loon.fill("ab 1234");
  await loon.press("Enter");
  await page.getByText("Already on Heron - use Edit if that's right.").waitFor();
  assert.equal((await readDoc("cottages/k1")).serialNumber, "");

  await loon.fill("ZX-9");
  await loon.press("Enter");
  await waitFor(async () => (await readDoc("cottages/k1")).serialNumber === "ZX-9", "the serial to save");
  await page.getByRole("button", { name: "Missing serial # (1)" }).waitFor();
  const log = (await readDoc("campground/data")).activityLog;
  assert.ok(log.some((l) => /Added serial # ZX-9 to Loon/.test(l.action || l.text || JSON.stringify(l))));

  // The edit form warns about a serial already on another cottage.
  await page.getByRole("button", { name: "Missing serial # (1)" }).click();
  await page.getByRole("row", { name: /Osprey/ }).getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Serial Number", { exact: true }).fill("zx9");
  await page.getByText("That serial number is already on Loon").waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("renaming a cottage keeps its ownership history", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await mountWithDb(page, cottagesView, READY);
  await page.getByRole("row", { name: /Loon/ }).getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Cottage Name / Number").fill("Loon Lodge");
  await page.getByRole("button", { name: "Save Cottage" }).click();
  await waitFor(async () => (await readDoc("cottages/k1")).name === "Loon Lodge", "the rename to save");
  const site = await waitFor(async () => { const x = await readDoc("sites/a"); return x.transferHistory[0].cottageId ? x : null; }, "the transfer to get the cottage's id");
  assert.equal(site.transferHistory[0].cottageId, "k1");
  await page.getByRole("button", { name: "Loon Lodge" }).first().click();
  await page.getByText("Transferred from Old Owner to Robert Smith").waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("a cottage off the park keeps its own owner, and a sale off-site takes its history along", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await mountWithDb(page, cottagesView, READY);

  // Osprey isn't on a site: give it an owner from its form.
  await page.getByRole("row", { name: /Osprey/ }).getByRole("button", { name: "Edit" }).click();
  const owner = page.getByLabel("Owner (not on a site)");
  await owner.fill("Robert Smith");
  await owner.press("Tab");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Save Cottage" }).click();
  const osprey = await waitFor(async () => { const x = await readDoc("cottages/k3"); return x.ownerCustomerId ? x : null; }, "the owner to save");
  assert.equal(osprey.ownerCustomerId, "c1");
  assert.equal(osprey.transferHistory[0].toCustomerName, "Robert Smith");
  await page.getByRole("button", { name: "Osprey" }).first().click();
  await page.getByText("Current Owner").waitFor();
  assert.ok(await page.getByRole("button", { name: "Robert Smith" }).first().isVisible(), "owner shows on the cottage");
  await page.getByText("Transferred from — to Robert Smith").waitFor();
  await page.keyboard.press("Escape");

  // Loon is sold out of the park: its site history goes with it.
  await page.getByRole("button", { name: "Loon" }).first().click();
  await page.getByRole("button", { name: "Transfer Ownership" }).click();
  await page.getByRole("button", { name: "Taking It Off-Site" }).click();
  await page.getByLabel("Please enter the location this cottage is being sold to").fill("Belleville, ON");
  await page.getByRole("button", { name: "Complete Sale" }).click();
  const loon = await waitFor(async () => { const x = await readDoc("cottages/k1"); return x.siteId === null && x.transferHistory ? x : null; }, "the off-site sale to save");
  assert.deepEqual(loon.transferHistory.map((t) => t.toCustomerName), ["Taken off-site", "Robert Smith"]);
  await page.getByText("Transferred from Old Owner to Robert Smith").waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
