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

test("Hydro Review can carry a small reading over to the next bill, or remove one (closing readings can't be carried)", async () => {
  await resetData({
    ...base("accounting"),
    "hydroReadings/a": { id: "a", siteId: "s42", date: "2026-09-01", reading: 1000, status: "confirmed", isBaseline: true },
    "hydroReadings/b": { id: "b", siteId: "s42", date: "2026-09-20", reading: 1012, previousReading: 1000, usage: 12, status: "pending", ownerAtReading: "c1" }
  });
  const review = await openApp(browser, "emulator", { role: "accounting", email: EMAIL });
  await mountWithDb(review, asUser("HydroReviewView"), READY(2));
  await review.getByRole("button", { name: "Carry over to next bill" }).click();
  await review.getByRole("button", { name: "Yes, carry over" }).click();
  const carried = await waitFor(async () => { const b = (await readings()).find((x) => x.id === "b"); return b.status === "carried" ? b : null; }, "the reading to be carried");
  assert.equal(carried.usage, 12);
  assert.equal(carried.amount, undefined, "nothing is billed");
  await review.getByText("All caught up").waitFor();
  const log = await waitFor(async () => ((await readDoc("campground/data")).activityLog || []).find((e) => /Carried hydro reading for site 42/.test(e.summary)), "the activity line");
  assert.ok(log);
  await review.close();

  // The next reading is measured from the last billed one, so it includes
  // the carried 12 kWh.
  const page = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await mountWithDb(page, asUser("HydroMeterView"), READY(2));
  await openSection(page);
  await page.getByRole("button", { name: "Enter Reading" }).first().click();
  await page.getByPlaceholder("e.g. 4213").fill("1100");
  await page.getByRole("button", { name: "Save Reading" }).click();
  const next = await waitFor(async () => (await readings()).find((x) => x.reading === 1100), "the next reading");
  assert.equal(next.previousReading, 1000);
  assert.equal(next.usage, 100);
  await page.close();

  const review2 = await openApp(browser, "emulator", { role: "accounting", email: EMAIL });
  await mountWithDb(review2, asUser("HydroReviewView"), READY(3));
  await review2.getByText(/Includes usage carried over from 2026-09-20 \(12 kWh\)/).waitFor();
  assert.equal(await review2.getByRole("button", { name: "Carry over to next bill" }).count(), 1);
  await review2.getByRole("button", { name: "Remove", exact: true }).click();
  await review2.getByRole("button", { name: "Yes, remove" }).click();
  await waitFor(async () => !(await readings()).some((x) => x.reading === 1100), "the reading to be removed");
  assert.deepEqual(review2.pageErrors, []);
  await review2.close();

  // A closing reading is billed to the seller right away: no Carry over.
  await writeDoc("hydroReadings/z", { id: "z", siteId: "s42", date: "2026-10-01", reading: 1200, previousReading: 1000, usage: 200, status: "pending", closingReading: true, ownerAtReading: "c1" });
  const review3 = await openApp(browser, "emulator", { role: "accounting", email: EMAIL });
  await mountWithDb(review3, asUser("HydroReviewView"), READY(3));
  await review3.getByText("Closing reading").first().waitFor();
  assert.equal(await review3.getByRole("button", { name: "Carry over to next bill" }).count(), 0);
  assert.ok(await review3.getByRole("button", { name: "Remove", exact: true }).isVisible());
  await review3.close();
});

test("Set meter digits suggests a count per site from its area and readings, and saves only what's ticked", async () => {
  await resetData({
    ...base("office"),
    "sites/s42": { id: "s42", number: "42", siteType: "Seasonal" },
    "sites/s43": { id: "s43", number: "43", siteType: "Seasonal" },
    "sites/s500": { id: "s500", number: "500", siteType: "Seasonal" },
    "sites/s501": { id: "s501", number: "501", siteType: "Seasonal" },
    "sites/s1001": { id: "s1001", number: "1001", siteType: "Seasonal", meterDigits: 5 },
    "hydroReadings/a": { id: "a", siteId: "s42", date: "2026-09-01", reading: 4213, status: "confirmed", isBaseline: true },
    "hydroReadings/b": { id: "b", siteId: "s43", date: "2026-09-01", reading: 52130, status: "confirmed", isBaseline: true },
    "hydroReadings/c": { id: "c", siteId: "s500", date: "2026-09-01", reading: 61234, status: "confirmed", isBaseline: true },
    "hydroReadings/d": { id: "d", siteId: "s501", date: "2026-09-01", reading: 4213, status: "confirmed", isBaseline: true }
  });
  const page = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await mountWithDb(page, asUser("HydroMeterView"), `(api) => api.db.sites.length === 5 && (api.db.hydroReadings || []).length === 4`);
  await page.getByRole("button", { name: "Set meter digits · 4 sites" }).click();
  const row = (n) => page.locator(`[data-meter-digits="${n}"]`);
  // Front of Park is 4 (a 5-digit reading there means a 5-digit meter);
  // Limestone South is 5, so a 4-digit reading there is a "check".
  assert.deepEqual(await Promise.all(["42", "43", "500", "501"].map((n) => row(n).locator("select").inputValue())), ["4", "5", "5", "5"]);
  assert.deepEqual(await Promise.all(["42", "43", "500", "501"].map((n) => row(n).locator("input[type=checkbox]").isChecked())), [true, true, true, false]);
  await row("501").locator("select").selectOption("4");
  await page.getByRole("button", { name: "Set 4 sites" }).click();
  const sites = await waitFor(async () => {
    const list = await readCollection("sites");
    return list.every((x) => x.meterDigits) ? list : null;
  }, "the digit counts");
  assert.deepEqual(Object.fromEntries(sites.map((x) => [x.number, x.meterDigits])), { "42": 4, "43": 5, "500": 5, "501": 4, "1001": 5 });
  await page.close();
});

test("The reading screen asks once how many digits the meter has, and works out a rollover with it", async () => {
  await resetData({ ...base("office"), "sites/s42": { id: "s42", number: "42", siteType: "Seasonal" }, "hydroReadings/a": { id: "a", siteId: "s42", date: "2026-09-01", reading: 9990, status: "confirmed", isBaseline: true } });
  const page = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await mountWithDb(page, asUser("HydroMeterView"), READY(1));
  await openSection(page);
  await page.getByRole("button", { name: "Enter Reading" }).first().click();
  await page.getByPlaceholder("e.g. 4213").fill("10");
  await page.locator("[data-digit-picker]").waitFor();
  assert.equal(await page.getByRole("button", { name: "4", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByText("Estimated usage: 20 kWh").waitFor();
  await page.getByRole("button", { name: "Save Reading" }).click();
  const site = await waitFor(async () => { const d = await readDoc("sites/s42"); return d && d.meterDigits ? d : null; }, "the site's digit count");
  assert.equal(site.meterDigits, 4);
  const r = await waitFor(async () => (await readings()).find((x) => x.id !== "a"), "the reading");
  assert.equal(r.usage, 20);
  assert.equal(r.rolledOver, true);
  await page.close();
});

test("The hydro bill email shows the previous and current readings with their dates, as well as the usage", async () => {
  await resetData({
    ...base("accounting"),
    "hydroReadings/a": { id: "a", siteId: "s42", date: "2026-06-01", reading: 1000, status: "confirmed", isBaseline: true },
    "hydroReadings/b": { id: "b", siteId: "s42", date: "2026-07-01", reading: 1012, previousReading: 1000, usage: 12, status: "carried" },
    "hydroReadings/c": { id: "c", siteId: "s42", date: "2026-09-20", reading: 1250, previousReading: 1000, usage: 250, status: "pending", ownerAtReading: "c1" }
  });
  const page = await openApp(browser, "emulator", { role: "accounting", email: EMAIL });
  await page.evaluate(() => { window.__sent = []; window.sendEmail = async (o) => { window.__sent.push(o); }; });
  await mountWithDb(page, asUser("HydroReviewView"), READY(3));
  await page.getByRole("button", { name: "Confirm & Send Invoice" }).click();
  await page.getByRole("button", { name: "Yes, send" }).click();
  await page.waitForFunction(() => window.__sent.length > 0);
  const mail = await page.evaluate(() => window.__sent.find((m) => m.toEmail === "rsmith@x.com"));
  const text = mail.message.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  // Measured from the last billed reading (June), not the carried one.
  assert.match(text, /Previous reading \(Jun 1, 2026\) 1000/);
  assert.match(text, /Current reading \(Sep 20, 2026\) 1250/);
  assert.match(text, /Usage 250 kWh/);
  await page.close();
});

test("Hydro bills get HYD numbers; a bill whose email fails is flagged and can be resent from Sent bills", async () => {
  await resetData({
    ...base("accounting"),
    "sites/s43": { id: "s43", number: "43", tags: ["Seasonal"] },
    "customers/c3": { id: "c3", name: "Nora North", email: "nora@x.com", siteIds: ["s43"] },
    "hydroReadings/old": { id: "old", siteId: "s42", date: "2026-05-01", reading: 900, status: "invoiced", invoiceNumber: "HYD-0007", confirmedUsage: 10, rate: 18.5, taxAmount: 0.24, amount: 2.09 },
    "hydroReadings/a": { id: "a", siteId: "s42", date: "2026-06-01", reading: 1000, status: "confirmed", isBaseline: true },
    "hydroReadings/c": { id: "c", siteId: "s42", date: "2026-09-20", reading: 1250, previousReading: 1000, usage: 250, status: "pending", ownerAtReading: "c1" },
    "hydroReadings/d": { id: "d", siteId: "s43", date: "2026-09-21", reading: 2100, previousReading: 2000, usage: 100, status: "pending", ownerAtReading: "c3" }
  });
  const page = await openApp(browser, "emulator", { role: "accounting", email: EMAIL });
  // Nora's email fails the first time.
  await page.evaluate(() => {
    window.__sent = [];
    window.__fail = new Set(["nora@x.com"]);
    window.sendEmail = async (o) => {
      if (window.__fail.has(o.toEmail)) throw new Error("Mailbox unavailable");
      window.__sent.push(o);
    };
  });
  await mountWithDb(page, `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(HydroReviewView, { db: api.db, persist: api.persist }))`, `(api) => api.db.sites.length === 2 && (api.db.hydroReadings || []).length === 4`);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Confirm & Send Invoice" }).first().click();
    await page.getByRole("button", { name: "Yes, send" }).click();
    await page.waitForTimeout(300);
  }
  const done = await waitFor(async () => {
    const list = await readings();
    const c = list.find((x) => x.id === "c"), d = list.find((x) => x.id === "d");
    return c.emailStatus && c.emailStatus !== "sending" && d.emailStatus && d.emailStatus !== "sending" ? { c, d } : null;
  }, "both bills");
  assert.deepEqual([done.c.invoiceNumber, done.d.invoiceNumber].sort(), ["HYD-0008", "HYD-0009"]);
  assert.equal(done.c.emailStatus, "sent");
  assert.equal(done.c.emailedTo, "rsmith@x.com");
  assert.equal(done.d.emailStatus, "failed");
  assert.match(done.d.emailError, /Mailbox unavailable/);
  const mail = await page.evaluate(() => window.__sent.find((m) => m.toEmail === "rsmith@x.com"));
  assert.equal(mail.subject, `Hydro Invoice ${done.c.invoiceNumber} — Site 42`);
  assert.match(mail.message.replace(/<[^>]+>/g, " "), new RegExp(`Please include\\s+${done.c.invoiceNumber}\\s+with your payment`));

  // Flagged on the review page; resend from Sent bills once the mailbox works.
  await page.getByRole("button", { name: /1 hydro bill didn't reach the customer/ }).click();
  const row = page.locator(`[data-hydro-bill="${done.d.invoiceNumber}"]`);
  await row.getByText("Didn't send").waitFor();
  await page.evaluate(() => window.__fail.clear());
  await row.getByRole("button", { name: "Resend" }).click();
  await row.getByRole("button", { name: "Send", exact: true }).click();
  const resent = await waitFor(async () => { const d = (await readings()).find((x) => x.id === "d"); return d.emailStatus === "sent" ? d : null; }, "the resend");
  assert.equal(resent.invoiceNumber, done.d.invoiceNumber, "same number when resent");
  assert.ok(await page.evaluate(() => window.__sent.some((m) => m.toEmail === "nora@x.com")));
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
