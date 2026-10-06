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

test("correspondence: a customer's work orders and invoices appear in their conversation at the right point", async () => {
  const page = await openApp(browser, "stub");
  const result = await page.evaluate(() => {
    const c = { id: "c1", name: "Anne Lee", email: "anne@x.com", siteIds: ["s1"] };
    const emails = [
      { id: "e1", customerId: "c1", direction: "in", fromEmail: "anne@x.com", subject: "Leak", body: "Dripping", receivedAt: "2026-09-28T13:00:00Z", workOrderId: "w-old" },
      { id: "e2", customerId: "c1", direction: "out", toEmail: "anne@x.com", subject: "Re: Leak", body: "Tuesday", receivedAt: "2026-09-28T14:00:00Z" },
      { id: "e3", customerId: "c1", direction: "in", fromEmail: "anne@x.com", subject: "Re: Leak", body: "Thanks", receivedAt: "2026-10-01T20:00:00Z" }
    ];
    const db = { settings: { taxRate: 13 }, sites: [{ id: "s1", number: "573" }], cottages: [], customers: [c], quotes: [], parts: [], staff: [], activityLog: [], cannedReplies: [], correspondence: emails,
      workOrders: [
        { id: "w-old", workOrderNumber: "WO-0400", title: "Made from the email", status: "Open", date: "2026-09-29", siteId: "s1", partsUsed: [], notes: [] },
        { id: "w-new", workOrderNumber: "WO-0412", title: "Fix tap", status: "Completed", date: "2026-09-29", customerId: "c1", createdAt: "2026-09-28T14:20:00Z", partsUsed: [], notes: [] },
        { id: "w-other", workOrderNumber: "WO-0500", title: "Someone else", status: "Open", date: "2026-09-29", siteId: "s9", createdAt: "2026-09-28T14:30:00Z", partsUsed: [], notes: [] },
        { id: "w-prev-owner", workOrderNumber: "WO-0100", title: "Previous owner's job", status: "Completed", date: "2026-09-29", siteId: "s1", customerId: "c-old", createdAt: "2026-09-28T14:40:00Z", partsUsed: [], notes: [] }
      ],
      invoices: [{ id: "i1", invoiceNumber: "INV-1088", customerId: "c1", date: "2026-09-30", sentDate: "2026-09-30", lineItems: [{ id: "l", quantity: 1, unitPrice: 100 }], laborHours: 0 }] };
    const order = (includeInvoices) => mergeCorrespondenceTimeline(emails, correspondenceTimelineMarkers(db, c, emails, { includeInvoices })).map((r) => r.type === "email" ? r.item.id : r.marker.key);
    const root = document.getElementById("root");
    ReactDOM.createRoot(root).render(React.createElement(CorrespondenceThread, { customer: c, db, persist() {}, saveCorrespondence() {}, saveWorkOrder() {}, saveInvoice() {}, onReply() {} }));
    return { withInvoices: order(true), withoutInvoices: order(false) };
  });
  assert.deepEqual(result.withInvoices, ["e1", "tl-wo-w-old", "e2", "tl-wo-w-new", "tl-inv-i1", "tl-sent-i1", "e3"]);
  assert.deepEqual(result.withoutInvoices, ["e1", "tl-wo-w-old", "e2", "tl-wo-w-new", "e3"]);
  // Rendered: markers with View buttons, and a switch that hides them (remembered).
  await page.locator('[data-timeline="workorder"]').first().waitFor();
  assert.equal(await page.locator("[data-timeline]").count(), 4);
  await page.locator('[data-timeline="emailed"]').getByText("to anne@x.com").waitFor();
  await page.getByLabel("Show work orders & invoices").uncheck();
  assert.equal(await page.locator("[data-timeline]").count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("qic-thread-markers")), "0");
  await page.getByLabel("Show work orders & invoices").check();
  await page.locator('[data-timeline="workorder"]').getByRole("button", { name: "View" }).first().click();
  await page.getByText("Made from the email").last().waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("correspondence: years before last year fold into a bar that opens on a click", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => {
    const y = new Date().getFullYear();
    const c = { id: "c1", name: "Anne Lee", email: "anne@x.com", siteIds: [] };
    const mail = (id, year, subject) => ({ id, customerId: "c1", direction: "in", status: "handled", fromEmail: "anne@x.com", subject, body: `Body ${id}`, receivedAt: `${year}-06-15T12:00:00Z` });
    const db = { settings: { taxRate: 13 }, sites: [], cottages: [], customers: [c], quotes: [], parts: [], staff: [], activityLog: [], cannedReplies: [], invoices: [],
      workOrders: [{ id: "w1", workOrderNumber: "WO-0001", title: "Old job", status: "Completed", customerId: "c1", createdAt: `${y - 3}-06-16T12:00:00Z`, date: `${y - 3}-06-16`, partsUsed: [], notes: [] }],
      correspondence: [mail("a", y - 3, "Three years ago"), mail("b", y - 2, "Two years ago"), mail("b2", y - 2, "Also two years ago"), mail("c", y - 1, "Last year"), mail("d", y, "This year")] };
    const root = ReactDOM.createRoot(document.getElementById("root"));
    window.__thread = (focusId) => root.render(React.createElement(CorrespondenceThread, { customer: c, db, persist() {}, saveCorrespondence() {}, saveWorkOrder() {}, onReply() {}, focusId }));
    window.__thread(null);
  });
  const y = await page.evaluate(() => new Date().getFullYear());
  await page.getByText("Body d", { exact: true }).waitFor();
  await page.getByText("Body c", { exact: true }).waitFor();
  assert.equal(await page.getByText("Body b", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Body a", { exact: true }).count(), 0);
  const bars = page.locator("[data-year]");
  assert.deepEqual(await bars.evaluateAll((els) => els.map((e) => e.textContent)), [`\u25B6${y - 3}1 email \u00B7 1 work orderShow`, `\u25B6${y - 2}2 emailsShow`]);
  await page.locator(`[data-year="${y - 2}"]`).click();
  await page.getByText("Body b", { exact: true }).waitFor();
  await page.getByText("Body b2", { exact: true }).waitFor();
  assert.equal(await page.getByText("Body a", { exact: true }).count(), 0);
  await page.locator(`[data-year="${y - 2}"]`).getByText("Hide").click();
  assert.equal(await page.getByText("Body b", { exact: true }).count(), 0);
  // An old email picked in the inbox opens its own year, and only that one.
  await page.evaluate(() => window.__thread("a"));
  await page.getByText("Body a", { exact: true }).waitFor();
  assert.equal(await page.getByText("Body b", { exact: true }).count(), 0);
  await page.locator(`[data-year="${y - 3}"]`).getByText("Hide").click();
  assert.equal(await page.getByText("Body a", { exact: true }).count(), 0, "it can still be folded");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("correspondence: with nothing from the last two years, the newest year is open", async () => {
  const page = await openApp(browser, "stub");
  const result = await page.evaluate(() => {
    const now = new Date(2026, 5, 1);
    const tl = [2021, 2023, 2023].map((yr, i) => ({ type: "email", at: `${yr}-03-0${i + 1}T12:00:00Z`, item: { id: String(i) } }));
    const g = correspondenceYearGroups(tl, now);
    return { first: g.firstShownYear, years: g.olderYears.map((o) => [o.year, o.emails]) };
  });
  assert.deepEqual(result, { first: 2025, years: [[2021, 1], [2023, 2]] });
  await page.close();
});

test("winterizing: the customer's note from the sign-up form shows on the card and the completion checklist", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => {
    const db = { settings: {}, sites: [{ id: "s1", number: "412" }], cottages: [{ id: "k1", name: "Maple Cottage", siteId: "s1" }], customers: [], parts: [] };
    const row = (request) => React.createElement(WinterizingRequestRow, { request, db, readOnly: false, selectMode: false, selected: false, onEdit() {}, onDelete() {}, onToggle() {}, onDirectComplete() {}, onToggleSelect() {}, onPrint() {}, onEmailCustomer() {}, onAnodeRodReplaced() {} });
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement("div", null,
      row({ id: "r1", cottageId: "k1", requestedDate: "2026-10-20", notes: "Dog in the yard \u2014 please close the gate.", options: { dishwasher: true } }),
      row({ id: "r2", cottageId: "k1", requestedDate: "2026-10-21", notes: "   ", options: {} })));
  });
  const notes = page.locator("[data-winter-note]");
  await notes.first().waitFor();
  assert.equal(await notes.count(), 1, "a blank note shows nothing");
  assert.equal(await notes.first().textContent(), "Customer note: Dog in the yard \u2014 please close the gate.");
  // Opening the completion checklist shows it there too.
  await page.getByRole("checkbox").first().click();
  await page.getByText("Check off each item as you complete it.", { exact: false }).waitFor();
  assert.equal(await notes.count(), 2);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("winterizing: seasonal cottages not signed up yet - list, reminders, and emailing everyone finished today", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => {
    window.__sent = [];
    window.__saved = [];
    window.__persisted = [];
    window.sendEmail = async (o) => { window.__sent.push(o); };
    const today = todayISO();
    const db = {
      settings: { winterizingSeasonStart: "01-01" }, activityLog: [], parts: [], pendingSignups: [],
      winterReminders: { k5: "2000-01-01T00:00:00Z" },
      sites: [
        { id: "s1", number: "101", siteType: "Seasonal" }, { id: "s2", number: "102", siteType: "Seasonal" }, { id: "s3", number: "103", siteType: "Seasonal" },
        { id: "s4", number: "104", siteType: "Transient" }, { id: "s5", number: "105", siteType: "Seasonal" }, { id: "s6", number: "106", siteType: "4 Season" }
      ],
      cottages: ["1", "2", "3", "4", "5", "6"].map((n) => ({ id: "k" + n, name: "Cottage " + n, siteId: "s" + n })),
      customers: [
        { id: "c1", name: "Anne Lee", email: "anne@x.com", siteIds: ["s1"] },
        { id: "c2", name: "Bo Day", email: "bo@x.com", siteIds: ["s2"] },
        { id: "c5", name: "Cy Fox", siteIds: ["s5"] }
      ],
      winterizingRequests: [
        { id: "old1", cottageId: "k1", archived: true, completed: true, completedDate: "2025-10-20" },
        { id: "r2", cottageId: "k2", customerId: "c2", requestedDate: today, completed: true, completedDate: today, options: {} }
      ]
    };
    const pending = [{ id: "p3", type: "winterizing", submittedSiteNumber: "103" }];
    window.__rows = cottagesNotSignedUpForWinter(db, pending).map((r) => [r.site.number, r.owner ? r.owner.name : null, r.lastYear, r.remindedAt]);
    const root = ReactDOM.createRoot(document.getElementById("root"));
    const render = (d) => root.render(React.createElement(WinterizingView, { db: d, persist: (next) => { window.__persisted.push(next); render(next); }, saveWinterizingRequest: (r) => window.__saved.push(r), deleteWinterizingRequest() {}, saveInvoice() {}, readOnly: false, pendingSignups: pending, removePendingSignup() {}, confirmPendingSignup() {} }));
    render(db);
  });
  // Seasonal cottages only (not transient or 4 Season), none signed up or waiting for review;
  // an old reminder from before this season doesn't count.
  assert.deepEqual(await page.evaluate(() => window.__rows), [["101", "Anne Lee", true, null], ["105", "Cy Fox", false, null]]);
  // On a computer the list is its own view, counted on its tab.
  await page.getByRole("tab", { name: "Not signed up \u00B7 2" }).click();
  // Owners with an email start ticked; one with no email can't be.
  assert.equal(await page.locator('[data-not-signed-up="101"] input').isChecked(), true);
  assert.equal(await page.locator('[data-not-signed-up="105"] input').isDisabled(), true);
  await page.locator('[data-not-signed-up="101"]').getByText("Winterized before").waitFor();
  await page.getByRole("button", { name: "Email reminder to 1" }).click();
  await page.getByText("Reminder sent to 1.").waitFor();
  const reminder = await page.evaluate(() => window.__sent[0]);
  assert.equal(reminder.toEmail, "anne@x.com");
  assert.match(reminder.message, /^Hi Anne Lee,/);
  assert.match(reminder.message, /Cottage 1 \(site 101\)/);
  assert.match(reminder.message, /https:\/\/www\.qicampark\.com\/winterization-sign-up/);
  const last = await page.evaluate(() => window.__persisted[window.__persisted.length - 1]);
  assert.ok(last.winterReminders.k1, "the reminder is recorded");
  await page.locator('[data-not-signed-up="101"]').getByText(/^Reminded /).waitFor();
  // Everyone finished today gets the completion email in one go.
  await page.getByRole("button", { name: "Email 1 finished today" }).click();
  await page.getByRole("button", { name: "Send 1 email" }).click();
  await page.getByText("Sent to 1.", { exact: true }).waitFor();
  const done = await page.evaluate(() => ({ sent: window.__sent[1], saved: window.__saved[0] }));
  assert.equal(done.sent.toEmail, "bo@x.com");
  assert.match(done.sent.subject, /^Your Cottage Has Been Winterized/);
  assert.ok(done.saved.completionEmailedAt);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

// A winterizing season in the stub app: two sections, one cottage done
// before, notes, extras; saves re-render like the real app.
async function openWinterizing(page) {
  await page.evaluate(() => {
    window.__saved = [];
    window.__workOrders = [];
    window.sendEmail = async () => {};
    const today = todayISO();
    const add = (n) => winterAddDays(today, n);
    let db = {
      settings: { winterizingSeasonStart: "01-01" }, activityLog: [], parts: [], trash: [], staff: [], workOrderTemplates: [], quotes: [], invoices: [], correspondence: [],
      sites: [{ id: "s1", number: "126", section: "Pebble Beach Seasonal", siteType: "Seasonal" }, { id: "s2", number: "233", section: "Limestone South", siteType: "Seasonal" }, { id: "s3", number: "107", section: "Pebble Beach Seasonal", siteType: "Seasonal" }],
      cottages: [{ id: "k1", name: "Willow", siteId: "s1" }, { id: "k2", name: "Cedar", siteId: "s2" }, { id: "k3", name: "Maple", siteId: "s3" }],
      customers: [{ id: "c1", name: "Bo Day", email: "bo@x.com", phone: "613-555-0177", siteIds: ["s1"] }, { id: "c2", name: "Gary C", email: "gary@x.com", siteIds: ["s2"] }, { id: "c3", name: "Anne Lee", email: "anne@x.com", siteIds: ["s3"] }],
      workOrders: [{ id: "w1", workOrderNumber: "WO-0388", title: "Deck boards", siteId: "s1", date: "2026-08-12", status: "Completed", partsUsed: [], notes: [] }],
      winterizingRequests: [
        { id: "r1", cottageId: "k1", customerId: "c1", requestedDate: today, notes: "Dog in the yard \u2014 close the gate.", options: { outsideTap: true, keyAtReception: true } },
        { id: "r2", cottageId: "k2", customerId: "c2", requestedDate: add(2), notes: "", options: { anodeRod: true } },
        { id: "r3", cottageId: "k3", customerId: "c3", requestedDate: add(-1), completed: true, completedDate: add(-1), options: {} },
        { id: "h1", cottageId: "k1", archived: true, completed: true, completedDate: "2025-10-18", options: { outsideTap: true } }
      ]
    };
    const root = ReactDOM.createRoot(document.getElementById("root"));
    const render = () => root.render(React.createElement(WinterizingView, { db, persist: (n) => { db = { ...n, winterizingRequests: db.winterizingRequests }; render(); }, saveWinterizingRequest: (r) => { window.__saved.push(r); db = { ...db, winterizingRequests: db.winterizingRequests.map((x) => x.id === r.id ? r : x) }; render(); }, deleteWinterizingRequest() {}, saveInvoice() {}, saveWorkOrder: (wo) => window.__workOrders.push(wo), readOnly: false, pendingSignups: [], removePendingSignup() {}, confirmPendingSignup() {} }));
    render();
  });
}

test("winterizing on a computer: overview cards, filters, and the cottage panel's checklist", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => { try { localStorage.removeItem("qic-winter-view"); } catch (e) {} });
  await openWinterizing(page);
  const stat = (label) => page.locator(`[data-stat="${label}"] .font-serif`).textContent();
  assert.equal(await stat("Signed up"), "3");
  assert.equal(await stat("Winterized"), "1");
  assert.equal(await stat("Planned today"), "1");
  assert.equal(await stat("Still to do"), "2");
  assert.equal(await stat("Completion emails"), "0 / 1");
  await page.locator('[data-section-progress="Pebble Beach Seasonal"]').getByText("1 / 2").waitFor();
  // Filters.
  await page.getByRole("button", { name: "Has a note 1" }).click();
  assert.equal(await page.locator("[data-winter-row]").count(), 1);
  await page.getByRole("button", { name: "All 3" }).click();
  assert.equal(await page.locator("[data-winter-row]").count(), 3);
  // The cottage panel: owner, note, history, and the checklist gate.
  await page.locator('[data-winter-row="r1"]').click();
  const panel = page.locator('[data-winter-panel="r1"]');
  await panel.getByText("bo@x.com \u00B7 613-555-0177").waitFor();
  await panel.getByText("Customer note:").waitFor();
  await panel.getByText("2025 \u00B7 winterized Oct 18").waitFor();
  await panel.getByText("WO-0388 \u00B7 Deck boards", { exact: false }).waitFor();
  await panel.getByText("Key left with reception").waitFor();
  const mark = panel.getByRole("button", { name: /^Mark winterized/ });
  assert.equal(await mark.isDisabled(), true);
  await panel.getByText(/^Standard winterization/).click();
  await panel.getByText("Outside tap or shower").click();
  assert.equal(await mark.isDisabled(), false);
  await mark.click();
  const saved = await page.evaluate(() => window.__saved[window.__saved.length - 1]);
  assert.equal(saved.id, "r1");
  assert.equal(saved.completed, true);
  await panel.getByText("Completion email not sent yet").waitFor();
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("winterizing on a computer: plan by dragging cottages onto days, and log a problem found", async () => {
  const page = await openApp(browser, "stub");
  await openWinterizing(page);
  await page.getByRole("tab", { name: "Plan" }).click();
  const today = await page.evaluate(() => todayISO());
  const inTwo = await page.evaluate(() => winterAddDays(todayISO(), 2));
  const inOne = await page.evaluate(() => winterAddDays(todayISO(), 1));
  // Cedar is planned for its requested day; Willow for today.
  await page.locator(`[data-plan-column="${today}"] [data-plan-card="r1"]`).waitFor();
  // Drag Willow to tomorrow (a weekday or not, a dropped-on day shows).
  const target = page.locator(`[data-plan-column="${inOne}"]`);
  if (await target.count()) {
    await page.locator('[data-plan-card="r1"]').dragTo(target);
    const moved = await page.evaluate(() => window.__saved[window.__saved.length - 1]);
    assert.deepEqual([moved.id, moved.plannedDate, moved.requestedDate], ["r1", inOne, today]);
    await target.locator('[data-plan-card="r1"]').getByText(/^asked for /).waitFor();
  }
  // Back to "To plan" takes it off the schedule.
  await page.locator('[data-plan-card="r2"]').dragTo(page.locator('[data-plan-column="pool"]'));
  const off = await page.evaluate(() => window.__saved[window.__saved.length - 1]);
  assert.deepEqual([off.id, off.plannedDate], ["r2", ""]);
  await page.locator('[data-plan-column="pool"] [data-plan-card="r2"]').getByText("No date").waitFor();
  assert.ok(inTwo);
  // Found a problem: a work order for that site, prefilled.
  await page.locator('[data-plan-card="r2"]').click();
  await page.getByRole("button", { name: "Found a problem" }).click();
  await page.getByText("New Work Order").first().waitFor();
  assert.equal(await page.getByPlaceholder("e.g. Fix leaking faucet").inputValue(), "Found while winterizing \u2014 Cedar");
  await page.getByRole("button", { name: "Save Work Order" }).click();
  const wo = await page.evaluate(() => window.__workOrders[0]);
  assert.equal(wo.siteId, "s2");
  assert.equal(wo.cottageId, "k2");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("winterizing on a phone keeps the simple list", async () => {
  const page = await openApp(browser, "stub", { viewport: { width: 390, height: 800 } });
  await openWinterizing(page);
  await page.getByText(/^Pending \(/).first().waitFor();
  assert.equal(await page.getByRole("tab", { name: "Plan" }).count(), 0);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("correspondence: voicemails show who called, are never linked or grouped, and stay out of customer threads", async () => {
  const page = await openApp(browser, "stub");
  const out = await page.evaluate(() => {
    const vm1 = { id: "v1", direction: "in", status: "new", customerId: "c1", fromEmail: "noreply@phones.example", subject: "V-Mail from SUSAN MARCH (613) 438-0648 to Service Department 106", body: "You have a new voicemail from (613) 438-0648", receivedAt: "2026-10-03T14:00:00Z", triage: { summary: "Large branch fell on neighbor's deck between sites 412A and 412B.", siteNumber: "412A" } };
    const vm2 = { id: "v2", direction: "in", status: "new", fromEmail: "noreply@phones.example", subject: "V-Mail from (647) 469-6932 to Service Department 106", body: "You have a new voicemail from (647) 469-6932", receivedAt: "2026-10-03T13:00:00Z" };
    const mail = { id: "m1", direction: "in", status: "new", customerId: "c1", fromEmail: "march@x.com", subject: "Deck", body: "Hello", receivedAt: "2026-10-03T12:00:00Z" };
    return {
      label: voicemailLabel(correspondenceVoicemail(vm1)),
      label2: voicemailLabel(correspondenceVoicemail(vm2)),
      plain: correspondenceVoicemail(mail),
      groups: groupCorrespondenceByCustomer([vm1, vm2, mail].map((c) => correspondenceVoicemail(c) ? { ...c, customerId: null } : c)).map((r) => r.ids)
    };
  });
  assert.equal(out.label, "Voicemail \u00B7 Susan March (613) 438-0648");
  assert.equal(out.label2, "Voicemail \u00B7 (647) 469-6932");
  assert.equal(out.plain, null);
  assert.deepEqual(out.groups, [["v1"], ["v2"], ["m1"]], "each voicemail is its own row");
  // In the inbox: labelled, not linked (even one linked before), no Link button.
  await page.evaluate(() => {
    const db = { settings: {}, activityLog: [], customers: [{ id: "c1", name: "Bill & Susan March", email: "march@x.com", siteIds: ["s1"] }], sites: [{ id: "s1", number: "412A" }], cottages: [], workOrders: [], invoices: [], quotes: [], parts: [], staff: [], cannedReplies: [], workOrderTemplates: [],
      correspondence: [
        { id: "v1", direction: "in", status: "new", customerId: "c1", fromEmail: "noreply@phones.example", subject: "V-Mail from SUSAN MARCH (613) 438-0648 to Service Department 106", body: "You have a new voicemail from (613) 438-0648", receivedAt: "2026-10-03T14:00:00Z", triage: { summary: "Large branch fell on neighbor's deck between sites 412A and 412B.", siteNumber: "412A" } },
        { id: "m1", direction: "in", status: "new", customerId: "c1", fromEmail: "march@x.com", subject: "Deck", body: "Hello there", receivedAt: "2026-10-03T12:00:00Z" }
      ] };
    window.__db = db;
    const noop = () => {};
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(CorrespondenceInboxView, { db, persist: noop, saveCorrespondence: noop, deleteCorrespondence: noop, saveCustomer: noop, saveWorkOrder: noop, savePropaneRequest: noop, saveTreeRequest: noop, saveCottage: noop }));
  });
  await page.getByText("Voicemail \u00B7 Susan March (613) 438-0648").first().click();
  await page.getByText("Voicemail \u00B7 not linked to a customer").waitFor();
  assert.equal(await page.getByRole("button", { name: "Link", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /^Link to / }).count(), 0, "no 'Link to the site owner' suggestion either");
  // The customer's own conversation leaves the voicemail out.
  await page.evaluate(() => ReactDOM.createRoot(document.getElementById("test") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "test" }))).render(React.createElement(CorrespondenceThread, { customer: window.__db.customers[0], db: window.__db, persist() {}, saveCorrespondence() {}, onReply() {} })));
  await page.locator("#test").getByText("Hello there").waitFor();
  assert.equal(await page.locator("#test").getByText(/V-Mail/).count(), 0);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("correspondence: every message in a customer's conversation can be deleted (to Trash)", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => {
    window.__deleted = [];
    window.__persisted = [];
    window.__calls = [];
    window.__callable = async (name, data) => { window.__calls.push([name, data]); return { data: { ok: true } }; };
    let db = { settings: {}, activityLog: [], trash: [], customers: [{ id: "c1", name: "Anne Lee", email: "anne@x.com", siteIds: [] }], sites: [], cottages: [], workOrders: [], invoices: [], quotes: [], parts: [], staff: [], cannedReplies: [], workOrderTemplates: [],
      correspondence: [
        { id: "a", direction: "in", status: "handled", customerId: "c1", fromEmail: "anne@x.com", subject: "First", body: "Older message", receivedAt: "2026-10-01T12:00:00Z" },
        { id: "b", direction: "out", status: "handled", sentVia: "zoho", customerId: "c1", toEmail: "anne@x.com", subject: "Re: First", body: "Duplicate copy", receivedAt: "2026-10-01T13:00:00Z" },
        { id: "c", direction: "in", status: "new", customerId: "c1", fromEmail: "anne@x.com", subject: "Second", body: "Newest message", receivedAt: "2026-10-02T12:00:00Z" }
      ] };
    const root = ReactDOM.createRoot(document.getElementById("root"));
    const render = () => root.render(React.createElement(CorrespondenceInboxView, { db, persist: (n) => { window.__persisted.push(n); db = n; render(); }, saveCorrespondence() {}, deleteCorrespondence: (id) => { window.__deleted.push(id); db = { ...db, correspondence: db.correspondence.filter((c) => c.id !== id) }; render(); }, saveCustomer() {}, saveWorkOrder() {}, savePropaneRequest() {}, saveTreeRequest() {}, saveCottage() {} }));
    render();
  });
  await page.getByText("Anne Lee").first().click();
  const card = (text) => page.locator("div.rounded-lg.border.p-3", { hasText: text });
  await card("Duplicate copy").waitFor();
  assert.equal(await page.getByRole("button", { name: "Delete this message" }).count(), 3, "one on each message");
  // Delete the duplicate (not the one that was clicked): it goes to Trash and the conversation stays open.
  await card("Duplicate copy").getByRole("button", { name: "Delete this message" }).click();
  await page.getByRole("button", { name: /^(Delete|Yes, delete)/ }).last().click();
  assert.deepEqual(await page.evaluate(() => window.__deleted), ["b"]);
  const trash = await page.evaluate(() => window.__persisted[window.__persisted.length - 1].trash);
  assert.equal(trash[0].data.id, "b");
  const calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(calls.map(([n, d]) => [n, d.direction, d.toEmail, d.subject, d.receivedAt]), [["trashEmailInZoho", "out", "anne@x.com", "Re: First", "2026-10-01T13:00:00Z"]], "its copy in Zoho goes to Zoho's Trash too");
  await card("Older message").waitFor();
  assert.equal(await card("Duplicate copy").count(), 0);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("trash: a deleted email can be read before restoring, and says where it was deleted", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => {
    window.__restored = [];
    const email = { id: "e1", direction: "in", fromEmail: "anne@x.com", subject: "Leak", body: "The tap leaks.\n\n\n\nThanks, Anne", receivedAt: "2026-10-01T12:00:00Z" };
    const db = { activityLog: [], trash: [
      { id: "t1", type: "correspondence", data: email, label: "Email \u2014 Leak", deletedAt: "2026-10-05T12:00:00Z", deletedIn: "Zoho" },
      { id: "t2", type: "site", data: { id: "s1", number: "0001" }, label: "Site 0001", deletedAt: "2026-10-04T12:00:00Z" }
    ] };
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(TrashModal, { db, persist() {}, saveCorrespondence: (c) => window.__restored.push(c), onClose() {} }));
  });
  await page.getByText("Deleted in Zoho").waitFor();
  assert.equal(await page.getByRole("button", { name: "View" }).count(), 1, "only emails have View");
  await page.getByRole("button", { name: "View" }).click();
  const shown = await page.locator("[data-trash-email]").innerText();
  assert.match(shown, /From anne@x\.com/);
  assert.match(shown, /The tap leaks\.\s+Thanks, Anne/);
  await page.getByRole("button", { name: "Restore" }).first().click();
  assert.deepEqual(await page.evaluate(() => window.__restored.map((c) => c.id)), ["e1"]);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("invoice form: typing in a line's description offers parts, labour rates and service calls, and a new line opens under it", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => {
    window.__saved = [];
    const parts = [{ id: "p1", name: "Washer", sku: "W-12", price: 20, salesAccount: "4010" }, { id: "p2", name: "Water heater element", price: 45 }];
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(InvoiceForm, { initial: null, sites: [], cottages: [], customers: [], parts, workOrders: [], invoiceNumber: "INV-26-0020", taxRate: 13, defaultShopSuppliesPercent: 5, rateOptions: RATE_OPTIONS, serviceCallOptions: SERVICE_CALL_OPTIONS, onSave: (inv) => window.__saved.push(inv), onCancel() {} }));
  });
  await page.getByRole("textbox").first().fill("Deck repair");
  const desc = () => page.getByPlaceholder(/^Description/);
  assert.equal(await desc().count(), 1);

  await desc().nth(0).fill("labour");
  const opts = await page.getByRole("option").allInnerTexts();
  assert.deepEqual(opts.map((o) => o.split(/\s*\$/)[0].trim()), ["Labour — Service Tech", "Labour — Labour Tech", "Labour — Warranty"], "every labour rate, not N/A");
  await page.getByRole("option", { name: /Labour — Service Tech/ }).click();
  assert.equal(await desc().count(), 2, "a new line opens under it");
  await page.getByLabel("Hours").fill("2");

  await desc().nth(1).fill("w-12");
  await page.getByRole("option", { name: /^Washer/ }).waitFor();
  await desc().nth(1).press("Enter");
  assert.equal(await desc().count(), 3);

  await desc().nth(2).fill("service");
  await page.getByRole("option", { name: /Service call — Tech/ }).click();
  assert.equal(await desc().count(), 4);
  assert.equal(await page.getByPlaceholder("Add from parts…").count(), 0, "no separate parts picker");
  assert.equal(await page.getByText("Hours Worked").count(), 0, "no separate labour fields");

  await page.getByRole("button", { name: "Save Invoice" }).click();
  const inv = await page.evaluate(() => window.__saved[0]);
  assert.deepEqual(inv.lineItems.map((l) => [l.kind || "part", l.description, l.quantity, l.unitPrice, l.account]), [["labour", "Labour — Service Tech", 2, 110, "4037"], ["part", "Washer", 1, 20, "4010"], ["serviceCall", "Service call — Tech", 1, 70, ""]]);
  const t = await page.evaluate((i) => computeQuoteTotals(i, 13), inv);
  // Shop supplies: the Admin default (5%) of parts + labour, not the service call.
  assert.equal(inv.shopSuppliesPercent, 5);
  assert.deepEqual([t.lineItemsSubtotal, t.laborCost, t.shopSupplies, t.serviceCall, t.subtotal], [20, 220, 12, 70, 322]);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("quote form: labour and service calls are typed into lines like invoices, and an older quote's hours become a line", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => {
    window.__saved = [];
    const parts = [{ id: "p1", name: "Washer", sku: "W-12", price: 20 }];
    const initial = { id: "q1", title: "Deck repair", date: "2026-10-01", status: "Draft", lineItems: [{ id: "a", description: "Lumber", quantity: 4, unitPrice: 10 }], laborHours: 3, laborRate: 65, laborRateType: "Labour Tech", serviceCallType: "General", serviceCall: 50, shopSuppliesMode: "percent", shopSuppliesPercent: 0 };
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(QuoteForm, { initial, sites: [], cottages: [], customers: [], parts, quotes: [], taxRate: 13, templates: [], rateOptions: RATE_OPTIONS, serviceCallOptions: SERVICE_CALL_OPTIONS, onSave: (q) => window.__saved.push(q), onCancel() {} }));
  });
  const desc = () => page.getByPlaceholder(/^Description/);
  await desc().first().waitFor();
  assert.equal(await desc().count(), 4, "lumber, the labour line, the service call line and a blank line");
  assert.equal(await page.getByText("Hours Worked").count(), 0);
  await desc().nth(3).fill("washer");
  await desc().nth(3).press("Enter");
  assert.equal(await desc().count(), 5);
  await page.getByRole("button", { name: /Save/ }).first().click();
  const q = await page.evaluate(() => window.__saved[0]);
  assert.deepEqual(q.lineItems.map((l) => [l.kind || "part", l.description, l.quantity, l.unitPrice]), [["part", "Lumber", 4, 10], ["labour", "Labour — Labour Tech", 3, 65], ["serviceCall", "Service call — General", 1, 50], ["part", "Washer", 1, 20]]);
  assert.deepEqual([q.laborHours, q.serviceCall], [0, 0]);
  const t = await page.evaluate((x) => computeQuoteTotals(x, 13), q);
  assert.deepEqual([t.lineItemsSubtotal, t.laborCost, t.serviceCall, t.subtotal], [60, 195, 50, 305], "same totals as before");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("customers: tidy names takes the site number off the end, only after review", async () => {
  const page = await openApp(browser, "stub");
  const cases = await page.evaluate(() => ["Bill & Susan March (0412A)", "Anne Lee (107, 108)", "Bob Smith (Robert)", "Gary Callaghan", "Jo (412) Day", "(233)", "Tom Grant  (Site 518) "].map(nameWithoutSite));
  assert.deepEqual(cases, ["Bill & Susan March", "Anne Lee", "Bob Smith (Robert)", "Gary Callaghan", "Jo (412) Day", "(233)", "Tom Grant"]);
  await page.evaluate(() => {
    window.__saved = [];
    window.__persisted = [];
    const db = { activityLog: [], customers: [{ id: "c1", name: "Bill & Susan March (0412A)", email: "m@x.com" }, { id: "c2", name: "Anne Lee (107)" }, { id: "c3", name: "Gary Callaghan" }] };
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(CustomerNameTidyModal, { db, persist: (n) => window.__persisted.push(n), saveCustomer: async (c) => window.__saved.push(c), onClose() {} }));
  });
  assert.equal(await page.locator("[data-name-tidy]").count(), 2);
  assert.equal(await page.evaluate(() => window.__saved.length), 0, "nothing saved before confirming");
  await page.locator('[data-name-tidy="c2"] input').uncheck();
  await page.getByRole("button", { name: "Confirm 1 change" }).click();
  await page.waitForFunction(() => window.__saved.length === 1);
  const saved = await page.evaluate(() => window.__saved[0]);
  assert.deepEqual([saved.id, saved.name, saved.email], ["c1", "Bill & Susan March", "m@x.com"]);
  assert.match(await page.evaluate(() => window.__persisted[0].activityLog[0].summary), /site number off 1 customer name/);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("customers: fix couple names suggests the house style, only after review", async () => {
  const page = await openApp(browser, "stub");
  const cases = await page.evaluate(() => [
    { name: "Rita & Sam Moore" },
    { name: "Wayne Yolande McKinnon", name2: "Yolande McKinnon" },
    { name: "Wayne Yolande McKinnon" },
    { name: "Daniel & Sandra, Wood & Dewling" },
    { name: "Chris Knox & Debbie Roberston" },
    { name: "John Smith & Mary Smith" },
    { name: "Bill and Susan March (0412A)" },
    { name: "Wayne & Yolande, McKinnon" },
    { name: "Chris & Debbie Knox & Roberston" },
    { name: "Gary Callaghan" }
  ].map((c) => { const s = suggestCoupleName(c); return s && [s.after, s.sure]; }));
  assert.deepEqual(cases, [
    ["Rita & Sam, Moore", true],
    ["Wayne & Yolande, McKinnon", true],
    ["Wayne & Yolande, McKinnon", false],
    ["Daniel & Sandra Wood & Dewling", true],
    ["Chris & Debbie Knox & Roberston", true],
    ["John & Mary, Smith", true],
    ["Bill & Susan, March (0412A)", true],
    null, null, null
  ]);
  await page.evaluate(() => {
    window.__saved = [];
    window.__persisted = [];
    const db = { activityLog: [], settings: { coupleNamesReviewed: ["c5"] }, customers: [
      { id: "c1", name: "Rita & Sam Moore", email: "r@x.com" },
      { id: "c2", name: "Ann Marie Lee" },
      { id: "c3", name: "Joe Bloggs Day" },
      { id: "c4", name: "Gary Callaghan" },
      { id: "c5", name: "Tom Ann Grant" }
    ] };
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(CoupleNamesModal, { db, persist: (n) => window.__persisted.push(n), saveCustomer: async (c) => window.__saved.push(c), onClose() {} }));
  });
  assert.equal(await page.locator("[data-couple-name]").count(), 3, "already-reviewed and correct names are left out");
  assert.equal(await page.locator('[data-couple-name="c1"] input[type=checkbox]').isChecked(), true);
  assert.equal(await page.locator('[data-couple-name="c2"] input[type=checkbox]').isChecked(), false, "unsure ones start unticked");
  await page.locator('[data-couple-name="c3"] input[type=text]').fill("Joe & Bloggs, Day-Smith");
  assert.equal(await page.evaluate(() => window.__saved.length), 0, "nothing saved before confirming");
  await page.getByRole("button", { name: "Confirm 2 changes" }).click();
  await page.waitForFunction(() => window.__persisted.length === 1);
  const saved = await page.evaluate(() => window.__saved.map((c) => [c.id, c.name, c.email || ""]).sort());
  assert.deepEqual(saved, [["c1", "Rita & Sam, Moore", "r@x.com"], ["c3", "Joe & Bloggs, Day-Smith", ""]]);
  const settings = await page.evaluate(() => window.__persisted[0].settings);
  assert.deepEqual(settings.coupleNamesReviewed.sort(), ["c1", "c2", "c3", "c5"]);
  assert.match(await page.evaluate(() => window.__persisted[0].activityLog[0].summary), /Fixed 2 couple names/);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("correspondence: email bodies are shown without the disclaimer, the park's signature block or Zoho's blank-looking lines", async () => {
  const page = await openApp(browser, "stub");
  const zoho = "Hello Wayne,\n\nI can get a work order going.\n\n \n\nLet me know if you would like us to proceed.\n\n \n\nThank you\n\nService Department \n\nQuinte’s Isle Campark     \n\nservice@qicampark.com \n\nwww.qicampark.com  \n\nPhone: 613-476-6310 \n\nBook Now\n\n \n\nThe information contained in this email message is solely for the intended addressee.  This message may contain confidential and/or privileged material.  If you have received this message in error, please notify me immediately and destroy the message.  Thank you.";
  const out = await page.evaluate((t) => [
    displayEmailBody(t),
    displayEmailBody("Thanks, see you Tuesday.\n\nJohn Smith\nPhone: 613-555-1212"),
    displayEmailBody("We love Quinte's Isle Campark.\n\nService Department")
  ], zoho);
  assert.equal(out[0], "Hello Wayne,\n\nI can get a work order going.\n\nLet me know if you would like us to proceed.\n\nThank you");
  assert.equal(out[1], "Thanks, see you Tuesday.\n\nJohn Smith\nPhone: 613-555-1212", "a customer's own signature is left alone");
  assert.equal(out[2], "We love Quinte's Isle Campark.\n\nService Department", "one signature-like line on its own isn't removed");
  await page.close();
});

test("correspondence: our own addresses never match a customer, even if saved on one by mistake", async () => {
  const page = await openApp(browser, "stub");
  const out = await page.evaluate(() => {
    const customers = [{ id: "c7", name: "Gary & Lynn, Callaghan", email: "gary@x.com", matchEmails: ["service@qicampark.com", "Jayden@QICampark.com"] }];
    return [matchCustomerByEmail(customers, "service@qicampark.com"), matchCustomerByEmail(customers, "jayden@qicampark.com"), (matchCustomerByEmail(customers, "GARY@x.com") || {}).id, isParkEmail("info@quintesisle.ca")];
  });
  assert.deepEqual(out, [null, null, "c7", true]);
  await page.close();
});

test("invoices: payment instructions keep line breaks and make links and email addresses clickable", async () => {
  const page = await openApp(browser, "stub");
  const out = await page.evaluate(() => [
    paymentInstructionsHtml("Please make payment by e-transfer to krista@qicampark.com or via credit card https://forms.zohopublic.ca/quintesisle/form/SeasonalPaymentPortal/formperma/HUM6xPRgjAgGirxl4wjplMPipeYQXF8V218QDHuyiaM"),
    paymentInstructionsHtml("Cheques to <QIC>.\nSee https://qicampark.com."),
    buildHydroInvoiceEmailText({ number: "42" }, { name: "Robert Smith" }, 100, 18.5, 18.5, 2.41, 20.91, 13, { settings: { paymentInstructions: "Pay at https://qicampark.com/pay" } }, {}, "HYD-0001")
  ]);
  assert.match(out[0], /<a href="mailto:krista@qicampark\.com"[^>]*>krista@qicampark\.com<\/a>/);
  assert.match(out[0], /<a href="https:\/\/forms\.zohopublic\.ca\/quintesisle\/form\/SeasonalPaymentPortal\/formperma\/HUM6xPRgjAgGirxl4wjplMPipeYQXF8V218QDHuyiaM"[^>]*>QIC Payment Portal<\/a>/);
  assert.match(out[0], /or via credit card through the <a /);
  assert.equal(out[1], 'Cheques to &lt;QIC&gt;.<br>See <a href="https://qicampark.com" style="color:#377249;text-decoration:underline;" target="_blank" rel="noopener">qicampark.com</a>.', "text stays escaped; a short link shows as itself; the full stop isn't part of the link");
  assert.match(out[2], /<a href="https:\/\/qicampark\.com\/pay"/, "hydro bills use it too");
  await page.close();
});

test("invoices: numbers carry the year and start over each January; the email asks to include the number when something is owed", async () => {
  const page = await openApp(browser, "stub");
  const out = await page.evaluate(() => {
    const db = { invoices: [{ invoiceNumber: "INV-0009", date: "2026-09-01" }, { invoiceNumber: "INV-0031", date: "2025-11-01" }] };
    const owed = { invoiceNumber: "INV-26-0010", date: "2026-10-05", lineItems: [{ description: "Sealant", quantity: 1, unitPrice: 50 }], taxRate: 13 };
    const paid = { ...owed, invoiceNumber: "INV-26-0011", depositAmount: 56.5, paidInFullDate: "2026-10-05" };
    const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const d = { settings: {}, sites: [], cottages: [], customers: [] };
    return [
      nextInvoiceNumber(db, "2026-10-05"),
      nextInvoiceNumber({ invoices: [...db.invoices, { invoiceNumber: "INV-26-0010", date: "2026-10-05" }] }, "2026-10-06"),
      nextInvoiceNumber({ invoices: [{ invoiceNumber: "INV-26-0099", date: "2026-12-30" }] }, "2027-01-04"),
      nextHydroInvoiceNumber({ hydroReadings: [{ invoiceNumber: "HYD-0004", invoicedAt: "2026-09-01" }] }, "2026-10-05"),
      /Please include INV-26-0010 with your payment/.test(text(buildInvoiceEmailText(owed, d, 13))),
      /Please include/.test(text(buildInvoiceEmailText(paid, d, 13))),
      /Please include INV-26-0010 with your payment/.test(text(buildInvoiceHtml(owed, d, 13)))
    ];
  });
  assert.deepEqual(out, ["INV-26-0010", "INV-26-0011", "INV-27-0001", "HYD-26-0005", true, false, true]);
  await page.close();
});

test("work order print-off shows the WO number; Cash is a payment option everywhere", async () => {
  const page = await openApp(browser, "stub");
  const out = await page.evaluate(() => {
    const db = { settings: {}, sites: [], cottages: [], customers: [], parts: [], staff: [] };
    const html = buildWorkOrderHtml({ id: "w1", workOrderNumber: "WO-0088", title: "Loose front step", status: "Open", date: "2026-10-01", partsUsed: [], notes: [] }, db);
    return [/WO-0088/.test(html), PROPANE_PAYMENT_METHODS.includes("Cash"), INVOICE_PAYMENT_METHODS.includes("Cash"), ADVANCE_PAYMENT_METHODS.includes("Cash")];
  });
  assert.deepEqual(out, [true, true, true, true]);
  await page.close();
});

test("sites: numbers are written with 4 digits, and \"20\" still finds site 0020", async () => {
  const page = await openApp(browser, "stub");
  const out = await page.evaluate(() => {
    const sites = [{ id: "a", number: "1" }, { id: "b", number: "20" }, { id: "c", number: "412a" }, { id: "d", number: "K1" }, { id: "e", number: "1316" }, { id: "f", number: "33" }, { id: "g", number: "0033" }, { id: "h", number: "5", siteType: "QIC Facility" }];
    return {
      fmt: ["1", "20", "100", "412A", "412a", "1316", "K1", "A", " 7 "].map(formatSiteNumber),
      same: [sameSiteNumber("0020", "20"), sameSiteNumber("Site #20", "0020"), sameSiteNumber("0020", "200"), sameSiteNumber("K1", "k1")],
      todo: sitesToFormat(sites).map((r) => `${r.site.number}>${r.after}${r.clash ? "!" : ""}`),
      typed: (findSiteByTypedNumber([{ id: "b", number: "0020" }], "20") || {}).id
    };
  });
  assert.deepEqual(out.fmt, ["0001", "0020", "0100", "0412A", "0412A", "1316", "K1", "A", "0007"]);
  assert.deepEqual(out.same, [true, true, false, true]);
  assert.deepEqual(out.todo, ["1>0001", "20>0020", "33>0033!", "412a>0412A"], "a clash with an existing 0033 is flagged, not changed; park facilities are left alone");
  assert.equal(out.typed, "b");
  await page.close();
});

test("customers: phone numbers are stored as plain digits; Tidy phone numbers fixes existing ones after review", async () => {
  const page = await openApp(browser, "stub");
  const fmt = await page.evaluate(() => ["613-555-0148", "(613) 555-0148", "+1 613 555 0148", "613.555.0148", "6135550148", "613-555-0148 ext 2", "", "1-613-555-0148"].map(normalizePhone));
  assert.deepEqual(fmt, ["6135550148", "6135550148", "6135550148", "6135550148", "6135550148", "613-555-0148 ext 2", "", "6135550148"]);
  await page.evaluate(() => {
    window.__saved = [];
    window.__persisted = [];
    const db = { activityLog: [], customers: [
      { id: "c1", name: "Anne Lee", phone: "613-555-0148", phone2: "(613) 555-0199", email: "a@x.com" },
      { id: "c2", name: "Bo Day", phone: "6135550100" },
      { id: "c3", name: "Cy Fox", phone: "613-555-0111 ext 4" }
    ] };
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(PhoneTidyModal, { db, persist: (n) => window.__persisted.push(n), saveCustomer: async (c) => window.__saved.push(c), onClose() {} }));
  });
  assert.equal(await page.locator("[data-phone-tidy]").count(), 1, "only customers with something to change are listed");
  await page.getByRole("button", { name: "Tidy 1 customer" }).click();
  await page.waitForFunction(() => window.__saved.length === 1);
  const saved = await page.evaluate(() => window.__saved[0]);
  assert.deepEqual([saved.id, saved.phone, saved.phone2, saved.email], ["c1", "6135550148", "6135550199", "a@x.com"]);
  await page.close();
});

test("customers: the form warns when a typed email is already on file for another customer", async () => {
  const page = await openApp(browser, "stub");
  await page.evaluate(() => {
    const customers = [
      { id: "c1", name: "Anne Lee", email: "Anne@X.com" },
      { id: "c2", name: "Bo Day", email: "bo@y.com", matchEmails: ["bo.work@y.com"] },
      { id: "c3", name: "Park Office", email: "service@qicampark.com" }
    ];
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(CustomerForm, { initial: customers[0], sites: [], customers, onSave() {}, onCancel() {} }));
  });
  const note = page.getByText("is already on file for");
  assert.equal(await note.count(), 0, "a customer's own email isn't a duplicate");
  await page.getByLabel("Email Address").fill(" BO.work@y.com ");
  await page.getByText('"BO.work@y.com" is already on file for Bo Day').waitFor();
  await page.getByLabel("Email Address").fill("service@qicampark.com");
  assert.equal(await note.count(), 0, "park addresses don't warn");
  await page.getByLabel("Email", { exact: true }).fill("bo@y.com");
  await page.getByText('"bo@y.com" is already on file for Bo Day').waitFor();
  await page.close();
});

test("correspondence: the Handled list is in the order messages were sent or received", async () => {
  const page = await openApp(browser, "stub");
  const ids = await page.evaluate(() => handledCorrespondence([
    { id: "old-handled-today", direction: "in", status: "handled", receivedAt: "2026-09-20T10:00:00Z", handledAt: "2026-10-02T15:00:00Z" },
    { id: "zoho-reply", direction: "out", sentVia: "zoho", status: "handled", receivedAt: "2026-10-01T09:00:00Z", handledAt: "2026-10-01T09:00:00Z" },
    { id: "still-new", direction: "in", status: "new", receivedAt: "2026-10-02T11:00:00Z" },
    { id: "sent-yesterday", direction: "out", receivedAt: "2026-10-01T12:00:00Z" }
  ]).map((c) => c.id));
  assert.deepEqual(ids, ["sent-yesterday", "zoho-reply", "old-handled-today"]);
  await page.close();
});

test("correspondence: messages not linked to anyone are grouped by the other person's address", async () => {
  const page = await openApp(browser, "stub");
  const rows = await page.evaluate(() => groupCorrespondenceByCustomer([
    { id: "1", direction: "in", fromEmail: "Brenda.F@gmail.com" },
    { id: "2", direction: "out", toEmail: "brenda.f@gmail.com" },
    { id: "3", direction: "in", fromEmail: "other@x.com" },
    { id: "4", direction: "in", fromEmail: "x@y.com", customerId: "c1" },
    { id: "5", direction: "out", toEmail: "z@y.com", customerId: "c1" }
  ]).map((r) => r.ids));
  assert.deepEqual(rows, [["1", "2"], ["3"], ["4", "5"]]);
  await page.close();
});
