// Hydro readings: baselines, corrections without billing (Admin/Accounting
// only), the one-line-per-day activity log, and closing readings that bill
// the seller even after the sale is recorded.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readCollection, readDoc, writeDoc, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const EMAIL = "tester@qicampark.com";
const base = (role) => ({
  "campground/data": { settings: { taxRate: 13, hydroRate: 15 }, activityLog: [], staff: [], parts: [], workOrderTemplates: [], userRoles: { [EMAIL]: role, "boss@qicampark.com": "admin" } },
  "sites/s42": { id: "s42", number: "42", tags: ["Seasonal"] },
  "customers/c1": { id: "c1", name: "Robert Smith", email: "rsmith@x.com", siteIds: ["s42"] },
  "customers/c2": { id: "c2", name: "Bea Buyer", email: "bea@x.com", siteIds: [] }
});
// Signed in as EMAIL, so the screens use the same role the rules see.
const asUser = (view) => `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(${view}, { db: api.db, persist: api.persist }))`;
const readings = () => readCollection("hydroReadings");
// Sites are listed in folded sections (e.g. "Front of Park (1)"); open it.
const openSection = (page) => page.getByRole("button", { name: /\(1\)/ }).first().click();
const READY = (n) => `(api) => api.db.sites.length === 1 && api.db.customers.length === 2 && (api.db.hydroReadings || []).length === ${n}`;

test("A first reading is saved as the baseline, with one activity line for the day", async () => {
  await resetData(base("office"));
  const page = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await mountWithDb(page, asUser("HydroMeterView"), READY(0));
  await openSection(page);
  await page.getByRole("button", { name: "Enter Reading" }).first().click();
  await page.getByPlaceholder("e.g. 4213").fill("1000");
  await page.getByRole("button", { name: "Save Reading" }).click();
  const [r] = await waitFor(async () => { const list = await readings(); return list.length ? list : null; }, "the reading");
  assert.equal(r.reading, 1000);
  assert.equal(r.isBaseline, true);
  assert.equal(r.status, "confirmed");
  assert.equal(r.ownerAtReading, "c1");
  const log = await waitFor(async () => { const d = await readDoc("campground/data"); return (d.activityLog || []).length ? d.activityLog : null; }, "the activity log");
  assert.match(log[0].summary, /^Logged 1 hydro reading today \(1 baseline\)$/);
  await page.close();
});

test("Office staff don't get the Edit button on readings", async () => {
  await resetData({ ...base("office"), "hydroReadings/a": { id: "a", siteId: "s42", date: "2026-09-01", reading: 1000, status: "confirmed", isBaseline: true } });
  const page = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await mountWithDb(page, asUser("HydroMeterView"), READY(1));
  await openSection(page);
  await page.getByRole("button", { name: "History" }).first().click();
  await page.getByText("Baseline").first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit", exact: true }).count(), 0);
  await page.close();
});

test("Accounting can correct a baseline without billing, and the next reading's usage is recalculated", async () => {
  await resetData({
    ...base("accounting"),
    "hydroReadings/a": { id: "a", siteId: "s42", date: "2026-09-01", reading: 1000, status: "confirmed", isBaseline: true, previousReading: null, usage: null, flagged: false, rolledOver: false },
    "hydroReadings/b": { id: "b", siteId: "s42", date: "2026-10-01", reading: 1500, status: "pending", isBaseline: false, previousReading: 1000, usage: 500, flagged: false, rolledOver: false }
  });
  const page = await openApp(browser, "emulator", { role: "accounting", email: EMAIL });
  await mountWithDb(page, asUser("HydroMeterView"), READY(2));
  await openSection(page);
  await page.getByRole("button", { name: "History" }).first().click();
  const edits = page.getByRole("button", { name: "Edit", exact: true });
  await edits.first().waitFor();
  await edits.nth(1).click(); // newest first, so the second row is the baseline
  await page.getByText("Corrections don't send or create a bill").waitFor();
  await page.locator('input[type="number"]').last().fill("1100");
  await page.getByRole("button", { name: "Save correction" }).click();
  const next = await waitFor(async () => { const b = (await readings()).find((r) => r.id === "b"); return b && b.previousReading === 1100 ? b : null; }, "the next reading to be recalculated");
  assert.equal(next.usage, 400);
  assert.equal(next.status, "pending");
  const fixed = (await readings()).find((r) => r.id === "a");
  assert.equal(fixed.reading, 1100);
  assert.equal(fixed.invoicedAt || null, null, "a correction must not bill anything");
  await page.close();
});

test("A closing reading bills the seller even after the sale is recorded", async () => {
  await resetData({ ...base("office"), "hydroReadings/a": { id: "a", siteId: "s42", date: "2026-09-01", reading: 1000, status: "confirmed", isBaseline: true } });
  const page = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await mountWithDb(page, asUser("HydroMeterView"), READY(1));
  await openSection(page);
  await page.getByRole("button", { name: "Enter Reading" }).first().click();
  await page.getByPlaceholder("e.g. 4213").fill("1400");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save Reading" }).click();
  const r = await waitFor(async () => (await readings()).find((x) => x.reading === 1400), "the closing reading");
  assert.equal(r.closingReading, true);
  assert.equal(r.ownerAtReading, "c1");
  await page.close();

  // The sale is recorded: the site now belongs to Bea.
  await writeDoc("customers/c1", { id: "c1", name: "Robert Smith", email: "rsmith@x.com", siteIds: [] });
  await writeDoc("customers/c2", { id: "c2", name: "Bea Buyer", email: "bea@x.com", siteIds: ["s42"] });
  await writeDoc("campground/data", { ...base("accounting")["campground/data"] });
  const review = await openApp(browser, "emulator", { role: "accounting", email: EMAIL });
  await mountWithDb(review, asUser("HydroReviewView"), "(api) => api.db.customers.length === 2 && (api.db.customers.find((c) => c.id === 'c2').siteIds || []).length === 1 && (api.db.hydroReadings || []).length === 2");
  await review.getByText("Billed to Robert Smith, the owner when this was read").waitFor();
  assert.ok(await review.getByText("Closing reading").first().isVisible());
  await review.close();
});
