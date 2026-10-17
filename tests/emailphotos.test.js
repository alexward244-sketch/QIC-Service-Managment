// Photos a customer emails in go on the work order made from that email
// ("Include the photos from their email?", all ticked to start), show on the
// job tagged "Customer", and print on the work order - the crew's own photos
// don't print.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readDoc, readCollection, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ATTACHMENTS = [
  { url: PNG + "#leak", name: "leak.jpg" },
  { url: PNG + "#logo", name: "logo.png" },
  { url: "https://example.com/quote.pdf", name: "quote.pdf" },
  { url: "https://example.com/IMG_1.heic", name: "IMG_1.heic" }
];

test("Incoming: the email's photos are offered, an unticked one is left off, the rest go on the work order", async () => {
  const EMAIL = "reserve@qicampark.com";
  await resetData({
    "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], parts: [], workOrderTemplates: [], cannedReplies: [], userRoles: { [EMAIL]: "admin" } },
    "sites/a": { id: "a", number: "1051", section: "Pebble Beach", tags: [] },
    "cottages/k1": { id: "k1", name: "Loon", siteId: "a" },
    "customers/c1": { id: "c1", name: "Robert & Linda Smith", email: "rob@x.com", siteIds: ["a"] },
    "correspondence/m1": { id: "m1", direction: "in", status: "new", customerId: "c1", fromEmail: "rob@x.com", subject: "Leak under the sink", body: "Water under the kitchen sink, photos attached.", receivedAt: "2026-10-09T13:14:00Z", attachments: ATTACHMENTS, triage: { category: "service", summary: "Leak under the kitchen sink", priority: "High", needsReply: true } }
  });
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await page.evaluate(() => { window.sendEmail = async () => ({ ok: true }); });
  await page.clock.setFixedTime(new Date("2026-10-09T15:00:00Z"));
  const view = `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(IncomingView, { db: api.db, persist: api.persist, pendingSignups: api.pendingSignups, confirmPendingSignup: api.confirmPendingSignup, removePendingSignup: api.removePendingSignup, saveCorrespondence: api.saveCorrespondence, saveCustomer: api.saveCustomer, saveWorkOrder: api.saveWorkOrder, savePropaneRequest: api.savePropaneRequest, saveTreeRequest: api.saveTreeRequest, saveWinterizingRequest: api.saveWinterizingRequest, onGoToTab: () => {} }))`;
  await mountWithDb(page, view, "(api) => window.__ok || (window.__ok = api.db.correspondence.length >= 1 && api.db.customers.length === 1)");
  await page.locator('[data-incoming-row="c-m1"]').click();
  const picker = page.locator("[data-email-photos]");
  await picker.getByText("Include the 2 photos from their email?").waitFor();
  assert.deepEqual(await picker.locator("[data-email-photo]").evaluateAll((els) => els.map((e) => e.getAttribute("data-email-photo"))), ["leak.jpg", "logo.png"], "PDFs and HEIC photos aren't offered");
  await picker.locator('[data-email-photo="logo.png"]').click();
  assert.equal(await picker.locator('[data-email-photo="logo.png"]').getAttribute("aria-pressed"), "false");
  await page.locator("[data-incoming-main]").click();
  const wo = await waitFor(async () => (await readCollection("workOrders"))[0], "the work order");
  assert.equal(wo.photos.length, 1);
  assert.equal(wo.photos[0].url, PNG + "#leak");
  assert.equal(wo.photos[0].fromEmail, "m1");
  assert.equal(wo.photos[0].path, undefined, "no storage path, so removing it from the job never deletes the email's file");
  assert.equal((await readDoc("correspondence/m1")).attachments.length, 4, "the email keeps its attachments");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("the work order form from an email asks about its photos; the job shows them tagged Customer", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(({ ATTACHMENTS }) => {
    window.__saved = [];
    const db = { settings: {}, sites: [], cottages: [], staff: [], parts: [], customers: [], workOrders: [], workOrderTemplates: [] };
    const email = { id: "m9", direction: "in", subject: "Leak", receivedAt: "2026-10-09T13:14:00Z", attachments: ATTACHMENTS };
    ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(QuickWorkOrderModal, { db, initial: { title: "Leak under the sink", description: "" }, fromEmail: email, saveWorkOrder: (wo) => window.__saved.push(wo), onClose() {} }));
  }, { ATTACHMENTS });
  await page.getByText("Include the 2 photos from their email?").waitFor();
  await page.getByRole("button", { name: "Save Work Order" }).click();
  const saved = await page.evaluate(() => window.__saved[0]);
  assert.deepEqual(saved.photos.map((p) => p.name), ["leak.jpg", "logo.png"], "all ticked to start");
  assert.ok(saved.photos.every((p) => p.fromEmail === "m9" && p.by === "From the customer's email"));
  // On the job, the customer's photos are tagged.
  await page.evaluate((wo) => {
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(WorkOrderPhotos, { wo: { ...wo, photos: [...wo.photos, { id: "own", url: wo.photos[0].url, path: "work-order-photos/x/own.jpg", by: "Dave" }] }, saveWorkOrder() {}, actor: "Dave" }));
  }, saved);
  await page.getByRole("button", { name: "View photo", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "View the customer's photo" }).count(), 2);
  assert.equal(await page.getByRole("button", { name: "View photo", exact: true }).count(), 1);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("the printed work order shows the customer's photos, not the crew's", async () => {
  const page = await openApp(browser, "stub");
  const html = await page.evaluate(() => {
    const db = { settings: {}, sites: [], cottages: [], customers: [] };
    const wo = { id: "w1", title: "Leak", date: "2026-10-09", status: "Open", description: "Water under the sink", photos: [
      { id: "p1", url: "https://example.com/from-customer.jpg", fromEmail: "m1" },
      { id: "p2", url: "https://example.com/crew-after.jpg", path: "work-order-photos/w1/after.jpg" }
    ] };
    return { withPhotos: buildWorkOrderHtml(wo, db), without: buildWorkOrderHtml({ ...wo, photos: [wo.photos[1]] }, db) };
  });
  assert.match(html.withPhotos, /Photos from the customer/);
  assert.match(html.withPhotos, /from-customer\.jpg/);
  assert.doesNotMatch(html.withPhotos, /crew-after\.jpg/);
  assert.doesNotMatch(html.without, /Photos from the customer/);
  await page.close();
});
