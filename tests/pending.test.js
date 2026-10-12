// Pending work orders: booked ahead with a start date, kept out of today's
// counts, with reminders on set days - each Admin / Service Manager
// answers their own pop-up, and changing the date starts them over.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readDoc, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const TODAY = "2026-10-14";
const seed = (wo = {}) => resetData({
  "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], parts: [], workOrderTemplates: [], userRoles: { "alex@x.com": "admin", "sam@x.com": "manager" } },
  "sites/a": { id: "a", number: "1051" },
  "workOrders/w1": { id: "w1", workOrderNumber: "WO-0500", title: "Deck rebuild", status: "Pending", startDate: "2026-10-21", pendingSince: "2026-09-20", date: "2026-09-20", siteId: "a", notes: [], partsUsed: [], ...wo }
});
const prompt = (email) => `(api) => React.createElement(CurrentUserContext.Provider, { value: "${email}" }, React.createElement(PendingJobsPrompt, { db: api.db, persist: api.persist, saveWorkOrder: api.saveWorkOrder }))`;
const READY = "(api) => api.db.workOrders.length >= 1";
async function page_(email) {
  const page = await openApp(browser, "emulator", { role: "admin", email });
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00`));
  return page;
}

test("the reminder logic: set days only, weekend reminders carry to the next open, daily from the start date", async () => {
  await seed();
  const page = await page_("alex@x.com");
  const r = await page.evaluate(() => {
    const w = { status: "Pending", startDate: "2026-11-20", pendingSince: "2026-10-01" };
    return {
      dates: pendingReminderDates(w),
      before: pendingReminderDue(w, "2026-10-20"),
      onDay: pendingReminderDue(w, "2026-10-21"),
      between: pendingReminderDue(w, "2026-11-08"),
      started: pendingReminderDue(w, "2026-11-22"),
      tooLate: pendingReminderDates({ startDate: "2026-11-20", pendingSince: "2026-11-10" }),
      counted: [woActive({ status: "Pending" }), woActive({ status: "Open" }), isOverdue({ status: "Pending", date: "2020-01-01" })],
      statuses: STATUS
    };
  });
  assert.deepEqual(r.dates, ["2026-10-21", "2026-11-06", "2026-11-13", "2026-11-18"]);
  assert.equal(r.before, null);
  assert.equal(r.onDay, "2026-11-20@2026-10-21");
  assert.equal(r.between, "2026-11-20@2026-11-06");
  assert.equal(r.started, "2026-11-20@2026-11-22");
  assert.deepEqual(r.tooLate, ["2026-11-13", "2026-11-18"], "set late, the month and two-week reminders are skipped");
  assert.deepEqual(r.counted, [false, true, false]);
  assert.deepEqual(r.statuses, ["Open", "In Progress", "Pending", "Completed"]);
  await page.close();
});

test("each person answers their own pop-up: Not yet hides it only for them", async () => {
  await seed();
  const page = await page_("alex@x.com");
  await mountWithDb(page, prompt("alex@x.com"), READY);
  await page.getByText("Pending jobs coming up").waitFor();
  await page.getByText("Starts 2026-10-21 (in 7 days)").waitFor();
  await page.getByRole("button", { name: /Not yet/ }).click();
  await waitFor(async () => ((await readDoc("workOrders/w1")).reminderSeen || {})["alex@x,com"] === "2026-10-21@2026-10-14", "Alex's answer to be saved");
  assert.equal((await readDoc("workOrders/w1")).status, "Pending");
  await page.close();
  // Sam (Service Manager) still gets it.
  const page2 = await page_("sam@x.com");
  await mountWithDb(page2, prompt("sam@x.com"), READY);
  await page2.getByText("Pending jobs coming up").waitFor();
  await page2.getByRole("button", { name: "Move to In Progress" }).click();
  await waitFor(async () => (await readDoc("workOrders/w1")).status === "In Progress", "the job to move");
  assert.deepEqual(page2.pageErrors, []);
  await page2.close();
});

test("changing the date starts the reminders over", async () => {
  await seed();
  const page = await page_("alex@x.com");
  await mountWithDb(page, prompt("alex@x.com"), READY);
  await page.getByRole("button", { name: "Change date" }).click();
  await page.getByLabel("New start date").fill("2026-12-15");
  await page.getByRole("button", { name: "Save date" }).click();
  const w = await waitFor(async () => { const d = await readDoc("workOrders/w1"); return d.startDate === "2026-12-15" && d; }, "the new date");
  assert.equal(w.pendingSince, TODAY);
  assert.deepEqual(w.reminderSeen, {});
  assert.equal(w.status, "Pending");
  await waitFor(async () => (await page.getByText("Pending jobs coming up").count()) === 0, "no reminder due yet for the new date");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("a work order set to Pending needs a start date", async () => {
  await seed({ status: "Completed" });
  const page = await page_("alex@x.com");
  // The "Add … to save" hint shows in the harness's own app; catch it here.
  await page.evaluate(() => { window.__saved = []; window.__hints = []; window.needToSave = (what) => window.__hints.push(what); });
  await mountWithDb(page, `(api) => React.createElement(CurrentUserContext.Provider, { value: "alex@x.com" }, React.createElement(WorkOrderForm, { initial: { title: "Deck rebuild", siteId: "a" }, sites: api.db.sites, cottages: api.db.cottages, staff: [], parts: [], customers: api.db.customers, workGroups: [], templates: [], taxRate: 13, workOrders: api.db.workOrders, rateOptions: getLaborRateOptions(api.db), workOrderNumber: "WO-0501", onSave: (w) => window.__saved.push(w), onCancel() {}, onDirtyChange() {} }))`, READY);
  await page.getByRole("button", { name: /More details/ }).click();
  await page.locator("select").filter({ hasText: "Pending" }).selectOption("Pending");

  await page.getByRole("button", { name: /Save/ }).last().click();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__saved.length), 0, "not saved without a start date");
  assert.deepEqual(await page.evaluate(() => window.__hints), ["a start date"]);
  await page.getByLabel("Start date").fill("2026-12-01");

  await page.getByText(/Reminders: 11-01, 11-17, 11-24, 11-29/).waitFor();
  await page.getByRole("button", { name: /Save/ }).last().click();
  const saved = await waitFor(() => page.evaluate(() => window.__saved[0]), "the save");
  assert.equal(saved.status, "Pending");
  assert.equal(saved.startDate, "2026-12-01");
  assert.equal(saved.pendingSince, TODAY);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
