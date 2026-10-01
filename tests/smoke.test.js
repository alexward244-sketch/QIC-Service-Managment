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
