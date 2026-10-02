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

test("field propane runs say where each tank is, and warn when nothing is linked", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 900 } });
  await page.evaluate(() => {
    const db = { sites: [{ id: "s1", number: "530" }, { id: "s2", number: "1015" }], cottages: [{ id: "k1", name: "Maple", siteId: "s1" }], customers: [{ id: "c1", name: "Lynn Morris" }], parts: [] };
    const row = (request) => React.createElement(FieldPropaneRow, { request: { run: "10am", completed: false, ...request }, db, onComplete() {}, onExpired() {}, onMoveRun() {} });
    ReactDOM.createRoot(document.getElementById("test")).render(React.createElement("div", null,
      row({ id: "a", cottageId: "k1" }), row({ id: "b", siteId: "s2", customerId: "c1" }), row({ id: "c", customerId: "c1" })));
  });
  await page.getByText("Site 530 · Maple").waitFor();
  assert.ok(await page.getByText("Site 1015").isVisible(), "a site on the request itself is used");
  assert.equal(await page.getByText("No site or cottage linked").count(), 1, "only the unlinked one is flagged");
  assert.equal(await page.getByText("No site", { exact: true }).count(), 0);
  await page.close();
});

test("on a phone, opening a form doesn't jump into the first box; on a computer it still does", async () => {
  const render = () => ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(StaffForm, { initial: null, onSave() {}, onCancel() {} }));
  const phone = await openApp(browser, "stub", { viewport: { width: 390, height: 800 }, touch: true });
  await phone.evaluate(render);
  await phone.locator("#test input").first().waitFor();
  assert.equal(await phone.evaluate(() => document.activeElement && document.activeElement.tagName), "BODY", "nothing is focused on a phone");
  await phone.close();
  const computer = await openApp(browser, "stub");
  await computer.evaluate(render);
  await computer.locator("#test input").first().waitFor();
  assert.equal(await computer.evaluate(() => document.activeElement && document.activeElement.tagName), "INPUT");
  await computer.close();
});

test("field app: the phone's Back button steps back through screens instead of leaving", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 800 }, touch: true });
  await page.evaluate(() => {
    const wo = { id: "w1", workOrderNumber: "WO-0001", title: "Leaky tap", status: "Open", priority: "Medium", date: todayISO(), assignedTo: "Dave", partsUsed: [], notes: [] };
    const db = { settings: {}, sites: [], cottages: [], customers: [], parts: [], staff: [], invoices: [], quotes: [], workOrders: [wo], workOrderTemplates: [], activityLog: [], propaneRequests: [], winterizingRequests: [], treeRequests: [], hydroReadings: [] };
    const noop = () => {};
    ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(FieldApp, { db, persist: noop, actor: "Dave", saveWorkOrder: noop, savePropaneRequest: noop, saveWinterizingRequest: noop, saveInvoice: noop, deleteInvoice: noop, saveQuote: noop, saveCottage: noop, saveSite: noop, saveCorrespondence: noop, deleteCorrespondence: noop, saveCustomer: noop, saveTreeRequest: noop, pendingSignups: [], confirmPendingSignup: noop, removePendingSignup: noop, isAdminOrManager: true, onCreateInvoice: noop, onGoToDesktopTab: noop, onSignOut: noop }));
  });
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByText("Leaky tap").first().click();
  await page.getByRole("button", { name: "Start Job" }).waitFor();
  await page.goBack();
  await page.getByPlaceholder(/Search site/).waitFor();
  await page.goBack();
  await page.getByText("My Jobs").first().waitFor();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Parts" }).click();
  await page.getByText("←", { exact: false }).first().click();
  await page.getByRole("button", { name: "Hydro Readings" }).waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("field Park tab: browse by section and remember recently opened sites", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 900 } });
  await page.evaluate(() => {
    localStorage.removeItem("qic-field-park-recent");
    const db = { settings: {}, sites: [{ id: "s1", number: "12", section: "Limestone South" }, { id: "s2", number: "9", section: "Limestone South" }, { id: "s3", number: "1065", section: "Pebble Beach Seasonal" }], cottages: [], customers: [], workOrders: [], correspondence: [], parts: [], staff: [], invoices: [], quotes: [], activityLog: [] };
    ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(FieldParkScreen, { db, persist() {}, saveWorkOrder() {}, saveCottage() {}, saveSite() {}, saveCorrespondence() {} }));
  });
  await page.getByText("Browse by section").waitFor();
  const sections = await page.locator("button[aria-expanded] > span:first-child").allTextContents();
  assert.deepEqual(sections, ["Pebble Beach Seasonal", "Limestone South"], "sections in the park's usual order");
  await page.getByRole("button", { name: /Limestone South/ }).click();
  assert.deepEqual(await page.locator("div.grid button").allTextContents(), ["9", "12"], "sites in number order");
  await page.getByRole("button", { name: "12", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("qic-field-park-recent"))), [{ kind: "Site", id: "s1" }]);
  await page.close();
});

test("field header shows Saving / Not sent yet when changes haven't reached the server", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 300 } });
  const label = (props) => page.evaluate((p) => {
    const el = document.getElementById("test");
    ReactDOM.flushSync(() => ReactDOM.createRoot(el).render(React.createElement(FieldHeader, { title: "Today", ...p })));
    return el.textContent;
  }, props);
  assert.match(await label({ online: true, pending: false }), /Synced/);
  assert.match(await label({ online: true, pending: true }), /Saving/);
  assert.match(await label({ online: false, pending: true }), /Not sent yet/);
  assert.match(await label({ online: false, pending: false }), /Offline/);
  await page.close();
});

test("site types: guessed from tags until set, and a set type always wins", async () => {
  const page = await openApp(browser, "stub");
  const r = await page.evaluate(() => ({
    guesses: [{ tags: ["Pebble Beach Seasonal"] }, { tags: ["Original Park 4-Season"] }, { section: "Limestone South" }, { tags: ["QIC Facility", "Seasonal"] }, { tags: ["Rental"] }, { tags: ["Waterfront"] }].map(guessSiteType),
    setWins: isHydroTrackedSite({ tags: ["Seasonal"], siteType: "Transient" }),
    rental: isHydroTrackedSite({ siteType: "Rental Cottage" }),
    fourSeason: isSeasonalSite({ siteType: "4 Season" })
  }));
  assert.deepEqual(r.guesses, ["Seasonal", "4 Season", "Seasonal", "QIC Facility", "Rental Cottage", "Transient"]);
  assert.equal(r.setWins, false, "a site set to Transient isn't read even if tagged Seasonal");
  assert.equal(r.rental, false, "rental cottages aren't in hydro readings");
  assert.equal(r.fourSeason, true);
  await page.close();
});

test("hydro readings include every seasonal and 4 season site, whatever the tag's wording", async () => {
  const page = await openApp(browser, "stub");
  const result = await page.evaluate(() => [
    { tags: ["Seasonal"] }, { tags: ["4 Season"] }, { tags: ["Pebble Beach Seasonal"] }, { tags: ["Seasonal - Limestone South"] },
    { tags: ["Original Park 4-Season"] }, { tags: [], section: "Original Park Seasonal" }, { tags: ["Limestone South"] }, { tags: [], section: "limestone south" },
    { tags: ["Transient"] }, { tags: [] }
  ].map((s) => isHydroTrackedSite(s)));
  assert.deepEqual(result, [true, true, true, true, true, true, true, true, false, false]);
  await page.close();
});

test("side panels (work order / invoice from a customer card) fit on a phone screen", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 800 } });
  await page.evaluate(() => ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(DrawerShell, { title: "Sunroom caulking", eyebrow: "Work order", width: "480px", onClose() {} }, React.createElement("p", null, "Customer's info: With heavy rain, we are having water seep in."))));
  await page.getByText("Sunroom caulking").waitFor();
  const width = await page.evaluate(() => [...document.querySelectorAll("div")].find((d) => d.style.width === "480px").getBoundingClientRect().width);
  assert.ok(width <= 390, `the 480px panel shrinks to the screen (got ${width}px)`);
  await page.close();
});

test("field app: reopening a completed, invoiced job asks first", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 800 } });
  await page.evaluate(() => {
    window.__saved = [];
    const wo = { id: "w1", workOrderNumber: "WO-0009", title: "Sunroom caulking", status: "Completed", completedDate: "2026-09-10", priority: "Medium", partsUsed: [], notes: [] };
    const db = { settings: {}, sites: [], cottages: [], customers: [], parts: [], staff: [], invoices: [{ id: "i1", sourceType: "workOrder", sourceId: "w1" }], workOrders: [wo], activityLog: [] };
    ReactDOM.createRoot(document.getElementById("test")).render(React.createElement(FieldJobDetailScreen, { db, persist() {}, actor: "Dave", wo, saveWorkOrder: (w) => window.__saved.push(w), onBack() {}, onCreateInvoice() {}, onGoToSiteMap() {}, setToast() {} }));
  });
  await page.getByRole("button", { name: "Reopen Job" }).click();
  await page.getByText("Reopen this job?").waitFor();
  assert.ok(await page.getByText(/already has an invoice/).isVisible());
  await page.getByRole("button", { name: "Keep completed" }).click();
  assert.deepEqual(await page.evaluate(() => window.__saved.length), 0, "nothing changes when you keep it completed");
  await page.getByRole("button", { name: "Reopen Job" }).click();
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__saved.map((w) => [w.status, w.completedDate])), [["Open", null]]);
  await page.close();
});
