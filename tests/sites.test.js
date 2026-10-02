// Site types: the one-time review that sets every site's type, editing a
// site keeps the fields its form doesn't show, and occupancy counts only
// seasonal sites.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readCollection, readDoc, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const EMAIL = "tester@qicampark.com";
const seed = () => resetData({
  "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], parts: [], workOrderTemplates: [], userRoles: { [EMAIL]: "admin" } },
  "sites/a": { id: "a", number: "101", section: "Pebble Beach Seasonal", tags: [], seasonalFee: 300, seasonalFeeHistory: [{ date: "2026-01-01", amount: 300 }] },
  "sites/b": { id: "b", number: "102", section: "Limestone South", tags: [] },
  "sites/c": { id: "c", number: "T1", section: "", tags: ["Waterfront"] },
  "sites/d": { id: "d", number: "R1", section: "", tags: ["Rental"] },
  "customers/c1": { id: "c1", name: "Robert Smith", siteIds: ["a"] }
});
const sitesView = `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(SitesView, { db: api.db, persist: api.persist, saveWorkOrder: api.saveWorkOrder, saveSite: api.saveSite, deleteSite: api.deleteSite, saveCottage: api.saveCottage, saveCorrespondence: api.saveCorrespondence, bulkWriteSites: api.bulkWriteSites, readOnly: false, filterPrefill: null }))`;
const READY = "(api) => api.db.sites.length === 4 && api.db.customers.length === 1";

test("Review site types sets every site's type in one go, and editing a site keeps its fee history", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await mountWithDb(page, sitesView, READY);
  await page.getByText("4 sites don't have a site type yet").waitFor();
  await page.getByRole("button", { name: "Review site types" }).click();
  await page.getByRole("button", { name: /^Transient1 site/ }).click();
  await page.getByLabel("Type for site T1").selectOption("Transient");
  await page.getByRole("button", { name: "Confirm all 4" }).click();
  const types = await waitFor(async () => { const list = await readCollection("sites"); return list.every((x) => x.siteType) ? Object.fromEntries(list.map((x) => [x.number, x.siteType])) : null; }, "site types to be saved");
  assert.deepEqual(types, { 101: "Seasonal", 102: "Seasonal", T1: "Transient", R1: "Rental Cottage" });
  await page.getByText("site type yet").waitFor({ state: "detached" });

  // Editing a site from its form keeps fields the form doesn't show.
  await page.getByRole("button", { name: /^Seasonal \(2\)/ }).click();
  await page.getByText("Pebble Beach Seasonal").first().click();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByLabel(/RMS Site ID/).fill("RMS-55");
  await page.getByRole("button", { name: /Save/ }).last().click();
  const a = await waitFor(async () => { const x = await readDoc("sites/a"); return x.rmsSiteId === "RMS-55" ? x : null; }, "the edit to save");
  assert.equal(a.siteType, "Seasonal");
  assert.deepEqual(a.seasonalFeeHistory, [{ date: "2026-01-01", amount: 300 }], "fee history survives an edit");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("the admin dashboard counts occupancy over seasonal sites only", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await mountWithDb(page, `(api) => React.createElement(AdminDashboardView, { db: api.db, persist: api.persist })`, READY);
  await page.getByText("Seasonal Sites Occupied").waitFor();
  assert.ok(await page.getByText("1 / 2").isVisible(), "2 seasonal sites (guessed), 1 with an owner");
  assert.ok(await page.getByText(/1 vacant · 1 transient · 1 rental cottage/).isVisible());
  await page.close();
});
