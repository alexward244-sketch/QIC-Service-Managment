// The app's code loads, and the main screens render without errors.
// Runs against a faked Firebase - no database needed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const PROPS = `{
  initial: null, sites: [{ id: "s1", number: "42" }], cottages: [], staff: [], customers: [],
  parts: [{ id: "p1", name: "Gas Test", price: 95, trackQuantity: false }], workGroups: [],
  templates: [{ id: "t1", name: "Gas Test", title: "Gas Test", description: "Check lines", priority: "Medium", defaultParts: [{ partId: "p1", quantity: 1 }] }],
  taxRate: 13, workOrders: [], rateOptions: getLaborRateOptions({ settings: {} }), workOrderNumber: "WO-0001",
  onSave: (w) => { window.__saved = w; }, onCancel() {}
}`;

test("the app's code loads without errors", async () => {
  const page = await openApp(browser, "stub");
  const result = await page.evaluate(() => ({ app: typeof App, useDb: typeof useDb, errors: window.__errors }));
  assert.equal(result.app, "function");
  assert.equal(result.useDb, "function");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("the login screen renders with Forgot password", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(LoginScreen)));
  await page.getByRole("button", { name: "Sign In" }).waitFor();
  await page.getByRole("button", { name: "Forgot password?" }).waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("a new work order from a template saves with its number and no blank fields", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(`ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(WorkOrderForm, ${PROPS}))`);
  await page.locator("#test select").first().selectOption("t1");
  await page.getByRole("button", { name: "Save Work Order" }).click();
  const saved = await page.evaluate(() => {
    const undef = [];
    const walk = (o, p) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (v === undefined) undef.push(p + k); else walk(v, p + k + "."); } };
    walk(window.__saved, "");
    return { number: window.__saved.workOrderNumber, title: window.__saved.title, parts: window.__saved.partsUsed, undef };
  });
  assert.equal(saved.number, "WO-0001");
  assert.equal(saved.title, "Gas Test");
  assert.deepEqual(saved.parts, [{ partId: "p1", quantity: 1 }]);
  assert.deepEqual(saved.undef, [], "a field came out undefined - Firestore would reject the save");
  await page.close();
});

test("the wrap-up window marks what's on the invoice", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(WorkOrderWrapUpModal, {
    wo: { id: "w1", title: "Leaky tap", status: "In Progress", partsUsed: [] }, db: { settings: {}, parts: [] }, actor: "Test", onComplete() {}, onCancel() {}
  })));
  await page.getByText("Wrap up: Leaky tap").waitFor();
  const badges = await page.locator("span").evaluateAll((els) => els.map((e) => e.textContent).filter((t) => t === "On the invoice" || t === "Internal only"));
  assert.deepEqual(badges.sort(), ["Internal only", "Internal only", "On the invoice", "On the invoice", "On the invoice"]);
  await page.close();
});

test("replying from a work order shows what the customer wrote above the reply box", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 900 } });
  await page.evaluate(() => ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(QuickEmailReplyModal, {
    toOptions: ["brenda@x.com"], toName: "Brenda", defaultSubject: "Re: Service Request", draftKey: null, draftContext: {},
    references: [{ label: "Their last email", text: "The wall panel is bulging." }, { label: "Work order", text: "" }, null],
    onClose() {}, onSend: async () => {}
  })));
  await page.getByText("What you're replying to").waitFor();
  assert.ok(await page.getByText("The wall panel is bulging.").isVisible());
  assert.equal(await page.getByText("Work order", { exact: true }).count(), 0, "empty sections are left out");
  await page.getByRole("button", { name: /Hide/ }).click();
  assert.equal(await page.getByText("The wall panel is bulging.").count(), 0);
  assert.ok(await page.locator("textarea").isVisible(), "the reply box is still there");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, "fits a phone screen");
  await page.close();
});

test("work order lists show what each job is about, without the web form's contact lines", async () => {
  const page = await openApp(browser, "stub");
  const gists = await page.evaluate(() => [
    workOrderGist({ title: "Service Request", description: "The wall panel is bulging.\n\nSubmitted by: Brenda Ferguson\nPhone: 613-555-0142\nEmail: b@x.com" }),
    workOrderGist({ title: "Fix deck", description: "Fix deck" }),
    workOrderGist({ title: "Long", description: "word ".repeat(100) }, 40),
    workOrderGist({ title: "Empty" })
  ]);
  assert.equal(gists[0], "The wall panel is bulging.");
  assert.equal(gists[1], "", "nothing shown when it would only repeat the title");
  assert.ok(gists[2].length <= 41 && gists[2].endsWith("…"));
  assert.equal(gists[3], "");
  await page.close();
});

test("field job screen: details first, billing folded away, next step pinned to the bottom", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 700 } });
  await page.evaluate(() => {
    const wo = { id: "w1", workOrderNumber: "WO-0088", title: "Loose front step", status: "Open", priority: "Low", siteId: "s1", customerId: "c1", description: "Front step is rocking.", partsUsed: [], notes: [], assignedTo: "Dave", date: "2026-10-01" };
    const db = { settings: {}, sites: [{ id: "s1", number: "1015" }], cottages: [], customers: [{ id: "c1", name: "Kevin Morris", phone: "613-555-0142" }], parts: [], staff: [], invoices: [], workOrders: [wo], activityLog: [] };
    window.__opened = null;
    ReactDOM.createRoot(document.getElementById("test")).render(React.createElement("div", { style: { height: "700px", overflowY: "auto", padding: "0 16px 20px" } }, React.createElement(FieldJobDetailScreen, { db, persist() {}, actor: "Dave", wo, saveWorkOrder() {}, onBack() {}, onCreateInvoice: (w) => { window.__opened = w.id; }, onGoToSiteMap() {}, setToast() {} })));
  });
  await page.getByText("WO-0088").waitFor();
  assert.ok(await page.getByRole("link", { name: "Call customer" }).isVisible());
  assert.equal(await page.getByText("Labor Hours").count(), 0, "billing starts folded");
  const start = page.getByRole("button", { name: "Start Job" });
  assert.ok(await start.isVisible(), "the next step is on screen without scrolling");
  const box = await start.boundingBox();
  assert.ok(box.y + box.height <= 700, "pinned within the screen");
  await page.getByRole("button", { name: /^Billing/ }).click();
  assert.ok(await page.getByText("Labor Hours").isVisible());
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("field app tabs have icons and mark the current tab", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 700 } });
  await page.evaluate(() => ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(FieldTabBar, { screen: "job", onSelect() {} })));
  await page.getByRole("button", { name: "Jobs" }).waitFor();
  assert.equal(await page.locator("button svg").count(), 5);
  assert.equal(await page.getByRole("button", { name: "Jobs" }).getAttribute("aria-current"), "page", "a job's screen counts as the Jobs tab");
  await page.close();
});

test("field jobs list: my jobs / everyone, grouped by when they're due, and search across statuses", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 900 } });
  await page.evaluate(() => {
    const t = todayISO();
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const W = (id, title, status, date, assignedTo, siteId) => ({ id, title, status, date, assignedTo, siteId, priority: "Medium", partsUsed: [], notes: [] });
    const db = { settings: {}, sites: [{ id: "s1", number: "1065" }, { id: "s2", number: "530" }], cottages: [], customers: [], staff: [{ id: "st1", name: "Dave" }], parts: [], workOrderTemplates: [], invoices: [], activityLog: [],
      workOrders: [W("a", "Leaky tap", "Open", day(-3), "Dave", "s1"), W("b", "Step", "Open", t, "st1", "s2"), W("c", "Gas test", "Open", day(4), "Mike", "s2"), W("d", "Old deck job", "Completed", day(-30), "Mike", "s1")] };
    function Host() {
      const [filter, setFilter] = React.useState("Open");
      const [whose, setWhose] = React.useState("mine");
      const [query, setQuery] = React.useState("");
      return React.createElement(FieldJobsScreen, { db, persist() {}, actor: "Dave", saveWorkOrder() {}, filter, onFilter: setFilter, whose, onWhose: setWhose, query, onQuery: setQuery, onOpenJob() {}, setToast() {} });
    }
    ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(Host));
  });
  await page.getByText("Overdue (1)").waitFor();
  assert.ok(await page.getByText("Today (1)").isVisible(), "a job assigned by staff id counts as mine");
  assert.equal(await page.getByText("Gas test").count(), 0, "someone else's job is hidden on My jobs");
  await page.getByRole("button", { name: "Everyone" }).click();
  await page.getByText("Coming up (1)").waitFor();
  await page.getByLabel("Search jobs").fill("1065");
  await page.getByText("2 matches across all statuses").waitFor();
  assert.ok(await page.getByText("Old deck job").isVisible(), "search finds completed jobs too");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
