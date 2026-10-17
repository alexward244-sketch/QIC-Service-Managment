// Correspondence on a phone (field app): the list with "Needs reply", a
// conversation read like a text thread with Reply / Work order / Done at the
// bottom, the full-screen reply box, ✉ Email for a fresh email, and linking
// a stranger. Nothing runs off the side of the screen.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readDoc, readCollection, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const EMAIL = "alex@x.com";
const seed = () => resetData({
  "campground/data": { settings: {}, activityLog: [], staff: [], parts: [], workOrderTemplates: [], cannedReplies: [{ id: "cr1", title: "Thanks", body: "Thanks, we'll be in touch." }], userRoles: { [EMAIL]: "admin" } },
  "sites/a": { id: "a", number: "1051" },
  "sites/b": { id: "b", number: "0412A" },
  "customers/c1": { id: "c1", name: "Robert & Linda Smith", email: "rsmith@bell.net", matchEmails: ["linda.smith@gmail.com"], siteIds: ["a"] },
  "customers/c4": { id: "c4", name: "Ann Lee", email: "ann@x.com", siteIds: ["b"] },
  "correspondence/m0": { id: "m0", direction: "out", status: "handled", customerId: "c1", fromEmail: "service@qicampark.com", toEmail: "linda.smith@gmail.com", subject: "Re: Water on the floor", body: "We'll be by Tuesday.", receivedAt: "2026-10-13T14:00:00Z" },
  "correspondence/m1": { id: "m1", direction: "in", status: "new", customerId: "c1", fromEmail: "linda.smith@gmail.com", fromName: "Linda Smith", subject: "Furnace noise", body: "The furnace is clicking again.", receivedAt: "2026-10-16T13:00:00Z", triage: { category: "service", summary: "Furnace clicking on start-up", priority: "High", needsReply: true } },
  "correspondence/m4": { id: "m4", direction: "in", status: "new", fromEmail: "stranger@x.com", fromName: "Pat", subject: "Hydro", body: "My bill is high.", receivedAt: "2026-10-15T13:00:00Z" }
});
const noop = "() => {}";
const app = `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(FieldApp, { db: api.db, persist: api.persist, actor: "Alex", saveWorkOrder: api.saveWorkOrder, savePropaneRequest: api.savePropaneRequest, saveWinterizingRequest: api.saveWinterizingRequest, saveInvoice: api.saveInvoice, deleteInvoice: ${noop}, saveQuote: api.saveQuote, saveCottage: api.saveCottage, saveSite: api.saveSite, saveCorrespondence: api.saveCorrespondence, deleteCorrespondence: api.deleteCorrespondence, saveCustomer: api.saveCustomer, saveTreeRequest: api.saveTreeRequest, pendingSignups: [], confirmPendingSignup: ${noop}, removePendingSignup: ${noop}, isAdminOrManager: true, onCreateInvoice: ${noop}, onGoToDesktopTab: ${noop}, onSignOut: null }))`;
const READY = "(api) => api.db.correspondence.length >= 3 && api.db.customers.length === 2";

async function phone() {
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL, viewport: { width: 390, height: 800 } });
  await page.evaluate(() => {
    window.history.replaceState({ qicField: { screen: "today", idx: 0 } }, "");
    window.__sent = [];
    window.sendEmail = async (m) => { window.__sent.push(m); return { ok: true }; };
  });
  await mountWithDb(page, app, READY);
  return page;
}
// More → Correspondence.
async function openCorrespondence(page) {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: /^Correspondence/ }).click();
}
const noSideways = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, "nothing runs off the side");

test("the list starts on Needs reply; Done marks a conversation handled", async () => {
  await seed();
  const page = await phone();
  await openCorrespondence(page);
  await page.getByRole("button", { name: "Needs reply · 2" }).waitFor();
  assert.equal(await page.locator("[data-convo]").count(), 2);
  await page.locator('[data-convo="peer:stranger@x.com"]').getByText("who is this?").waitFor();
  await noSideways(page);
  // A conversation reads oldest to newest, ours on the right.
  await page.locator('[data-convo="cust:c1"]').click();
  const sides = await page.locator("[data-bubble]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bubble")));
  assert.deepEqual(sides, ["us", "them"]);
  await page.getByText("Site 1051").waitFor();
  await noSideways(page);
  await page.locator("[data-corr-actions]").getByRole("button", { name: "Done" }).click();
  await waitFor(async () => (await readDoc("correspondence/m1")).status === "handled", "the email to be marked done");
  await page.getByRole("button", { name: "Needs reply · 1" }).waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("Reply opens full screen, sends, and marks what they sent as answered; ✉ Email starts a fresh one", async () => {
  await seed();
  const page = await phone();
  await openCorrespondence(page);
  await page.locator('[data-convo="cust:c1"]').click();
  await page.locator("[data-corr-actions]").getByRole("button", { name: "Reply" }).click();
  await page.locator("[data-field-composer]").waitFor();
  assert.equal(await page.getByLabel("Subject").inputValue(), "Re: Furnace noise");
  await page.getByLabel("Canned reply").selectOption("cr1");
  assert.equal(await page.getByLabel("Message").inputValue(), "Thanks, we'll be in touch.");
  await page.getByRole("button", { name: "Send" }).click();
  await waitFor(async () => (await readDoc("correspondence/m1")).status === "handled", "the email to be answered");
  const sent = await page.evaluate(() => window.__sent);
  assert.equal(sent[0].toEmail, "linda.smith@gmail.com", "replies go to the address it came from");
  const out = (await readCollection("correspondence")).filter((c) => c.direction === "out" && c.id !== "m0");
  assert.equal(out.length, 1);
  assert.equal(out[0].customerId, "c1");
  // Back on the conversation; ✉ Email is a new email, not a reply.
  await page.locator("[data-corr-actions]").waitFor();
  await page.getByRole("button", { name: "✉ Email" }).click();
  assert.equal(await page.getByLabel("Subject").inputValue(), "");
  await page.getByLabel("Subject").fill("Winterizing reminder");
  await page.getByLabel("Message").fill("Just a reminder about winterizing.");
  await page.getByRole("button", { name: "Send" }).click();
  await waitFor(async () => (await page.evaluate(() => window.__sent.length)) === 2, "the new email to send");
  assert.equal((await page.evaluate(() => window.__sent))[1].subject, "Winterizing reminder");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("a stranger's email asks who it is; linking it lets you reply", async () => {
  await seed();
  const page = await phone();
  await openCorrespondence(page);
  await page.locator('[data-convo="peer:stranger@x.com"]').click();
  assert.equal(await page.locator("[data-corr-actions]").getByRole("button", { name: "Reply" }).isDisabled(), true, "can't reply until it's linked");
  await page.getByRole("button", { name: "Search…" }).click();
  await page.getByPlaceholder("Search customer to link…").fill("Ann");
  await page.getByRole("button", { name: /Ann Lee/ }).click();
  await waitFor(async () => (await readDoc("correspondence/m4")).customerId === "c4", "the email to be linked");
  await page.getByText("Site 0412A").waitFor();
  assert.equal(await page.locator("[data-corr-actions]").getByRole("button", { name: "Reply" }).isDisabled(), false);
  await waitFor(async () => ((await readDoc("customers/c4")).matchEmails || []).includes("stranger@x.com"), "the address to be remembered");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
