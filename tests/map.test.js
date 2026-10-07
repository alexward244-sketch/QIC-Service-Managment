// Site Map service views: Hydro/Water/Sewer equipment placed on the map,
// sites linked to it, and "what does this affect" through the fed-from chain.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { launch, openApp } = require("./helpers/app");
const { resetData, readCollection, cleanup } = require("./helpers/emulator");
const { mountWithDb, waitFor } = require("./helpers/screens");

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); await cleanup(); });

const EMAIL = "tester@qicampark.com";
// A tiny grey PNG standing in for the uploaded map image.
const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const seed = (equipment = {}) => resetData({
  "campground/data": { settings: { taxRate: 13 }, activityLog: [], staff: [], parts: [], workOrderTemplates: [], userRoles: { [EMAIL]: "admin" }, campgroundMap: { imageUrl: IMG } },
  "sites/a": { id: "a", number: "0101", section: "North", tags: [], mapX: 10, mapY: 10 },
  "sites/b": { id: "b", number: "0102", section: "North", tags: [], mapX: 20, mapY: 10 },
  "sites/c": { id: "c", number: "0103", section: "North", tags: [], mapX: 30, mapY: 10 },
  "customers/c1": { id: "c1", name: "Robert Smith", phone: "6135550148", siteIds: ["a"] },
  ...equipment
});
const mapView = (admin) => `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(CampgroundMapView, { db: api.db, persist: api.persist, saveWorkOrder: api.saveWorkOrder, saveSite: api.saveSite, saveCottage: api.saveCottage, saveCorrespondence: api.saveCorrespondence, isAdminOrManager: ${admin}, onCreateWorkOrder: () => {} }))`;
const READY = "(api) => api.db.sites.length === 3 && api.db.customers.length === 1";
const equipmentNamed = async (name) => (await readCollection("mapEquipment")).find((e) => e.name === name);

test("add hydro equipment, link sites, chain a second piece and see everything the first one affects", async () => {
  await seed();
  const page = await openApp(browser, "emulator", { role: "manager", email: EMAIL });
  await mountWithDb(page, mapView(true), READY);
  await page.getByRole("button", { name: "Hydro", exact: true }).click();
  await page.getByRole("button", { name: "Edit Hydro Equipment" }).click();

  await page.getByRole("button", { name: "+ Add Hydro Equipment" }).click();
  await page.getByLabel("Name / Label").fill("T1");
  await page.getByRole("button", { name: "Next: Place on Map" }).click();
  await page.getByText("Click on the map to place T1").waitFor();
  await page.getByAltText("Campground map").click();
  const t1 = await waitFor(() => equipmentNamed("T1"), "T1 to save");
  assert.equal(t1.utility, "hydro");
  assert.equal(t1.type, "Transformer");
  assert.ok(t1.mapX != null && t1.mapY != null, "placed on the map");

  // Placing it goes straight into linking its sites.
  await page.getByText("Linking sites to").waitFor();
  await page.getByTitle("Site 0101").click();
  await page.getByTitle("Site 0102").click();
  await waitFor(async () => ((await equipmentNamed("T1")).siteIds || []).length === 2, "two sites linked to T1");
  await page.getByRole("button", { name: "Done", exact: true }).click();

  // A panel fed from T1; moving 0102 to it takes it off T1.
  await page.getByRole("button", { name: "+ Add Hydro Equipment" }).click();
  await page.getByLabel("Type").selectOption("Breaker Panel");
  await page.getByLabel("Name / Label").fill("P2");
  await page.getByLabel("Fed From").selectOption({ label: "T1 (Transformer)" });
  await page.getByRole("button", { name: "Next: Place on Map" }).click();
  await page.getByAltText("Campground map").click();
  await waitFor(() => equipmentNamed("P2"), "P2 to save");
  await page.getByText("Linking sites to").waitFor();
  await page.getByTitle("Site 0102").click();
  await page.getByTitle("Site 0103").click();
  const after = await waitFor(async () => {
    const [a, b] = [await equipmentNamed("T1"), await equipmentNamed("P2")];
    return b.siteIds.length === 2 && a.siteIds.length === 1 ? { a, b } : null;
  }, "0102 to move to P2");
  assert.deepEqual(after.a.siteIds, ["a"]);
  assert.deepEqual(after.b.siteIds.sort(), ["b", "c"]);
  assert.equal(after.b.fedFrom, after.a.id);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Done Editing Pins" }).click();

  // T1 affects its own site and everything on P2.
  await page.getByTitle("T1 (Transformer)").click();
  const panel = page.getByTestId("equipment-panel");
  await panel.getByText("Affects 3 sites").waitFor();
  assert.ok(await panel.getByText("Robert Smith").isVisible());
  assert.ok(await panel.getByText("via P2").first().isVisible());

  // A site shows what feeds it, up to the main.
  await panel.getByRole("button", { name: "Close" }).click();
  await page.getByTitle("Site 0103").click();
  await page.getByText("Fed by").waitFor();
  assert.ok(await page.getByRole("button", { name: "P2", exact: true }).isVisible());
  assert.ok(await page.getByText("\u2190 from").isVisible(), "then what P2 is fed from");
  assert.ok(await page.getByRole("button", { name: "T1", exact: true }).isVisible());

  // Water view has none of the hydro equipment.
  await page.getByRole("button", { name: "Water", exact: true }).click();
  await page.getByText("0 pieces of equipment").waitFor();
  assert.equal(await page.getByTitle("T1 (Transformer)").count(), 0);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("deleting equipment re-feeds what hung off it; Office can look but not edit", async () => {
  await seed({
    "mapEquipment/m": { id: "m", utility: "water", type: "Main Valve", name: "Main", mapX: 50, mapY: 50, siteIds: [], fedFrom: null },
    "mapEquipment/v1": { id: "v1", utility: "water", type: "Shut-off Valve", name: "V1", mapX: 40, mapY: 40, siteIds: ["a"], fedFrom: "m" },
    "mapEquipment/v2": { id: "v2", utility: "water", type: "Shut-off Valve", name: "V2", mapX: 60, mapY: 40, siteIds: ["b"], fedFrom: "v1" }
  });
  const office = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await mountWithDb(office, mapView(false), READY);
  await office.getByRole("button", { name: "Water", exact: true }).click();
  await office.getByTitle("Main (Main Valve)").click();
  await office.getByTestId("equipment-panel").getByText("Affects 2 sites").waitFor();
  assert.equal(await office.getByRole("button", { name: "Link Sites" }).count(), 0);
  assert.equal(await office.getByRole("button", { name: /Edit Water Equipment/ }).count(), 0);
  await office.close();

  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await mountWithDb(page, mapView(true), READY);
  await page.getByRole("button", { name: "Water", exact: true }).click();
  await page.getByTitle("V1 (Shut-off Valve)").click();
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("equipment-panel").getByRole("button", { name: "Delete" }).click();
  const list = await waitFor(async () => { const l = await readCollection("mapEquipment"); return l.length === 2 ? l : null; }, "V1 to be deleted");
  assert.equal(list.find((e) => e.id === "v2").fedFrom, "m", "V2 now fed from the main");
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

// "No power" emails: what feeds the site, and the piece several reporting
// sites share - shown to staff only, never sent.
const HOUR = 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const outageSeed = () => seed({
  "customers/c2": { id: "c2", name: "Debbie Knox", siteIds: ["b"] },
  "customers/c3": { id: "c3", name: "Wayne McKinnon", siteIds: ["c"] },
  "mapEquipment/t1": { id: "t1", utility: "hydro", type: "Transformer", name: "T1", mapX: 50, mapY: 50, siteIds: [], fedFrom: null },
  "mapEquipment/pa": { id: "pa", utility: "hydro", type: "Breaker Panel", name: "Panel A", mapX: 21, mapY: 12, siteIds: ["a", "b"], fedFrom: "t1" },
  "mapEquipment/pb": { id: "pb", utility: "hydro", type: "Breaker Panel", name: "Panel B", mapX: 31, mapY: 12, siteIds: ["c"], fedFrom: "t1", location: "Grey box behind the laundry" },
  "correspondence/e1": { id: "e1", direction: "in", status: "new", customerId: "c1", fromEmail: "robert@x.com", subject: "No power at the cottage", body: "Hi, we have no power since this morning.", receivedAt: iso(1 * HOUR) },
  "correspondence/e2": { id: "e2", direction: "in", status: "new", customerId: "c2", fromEmail: "debbie@x.com", subject: "Help", body: "Our breaker keeps tripping and now everything is off.", receivedAt: iso(2 * HOUR) },
  "correspondence/e3": { id: "e3", direction: "in", status: "new", customerId: "c3", fromEmail: "wayne@x.com", subject: "Question about my hydro bill", body: "Can you explain the usage?", receivedAt: iso(3 * HOUR) },
  "correspondence/e4": { id: "e4", direction: "in", status: "new", customerId: "c3", fromEmail: "wayne@x.com", subject: "Sewer", body: "The toilet won't flush.", receivedAt: iso(30 * HOUR) }
});
const inboxView = `(api) => React.createElement(CurrentUserContext.Provider, { value: "${EMAIL}" }, React.createElement(CorrespondenceInboxView, { db: api.db, persist: api.persist, saveCorrespondence: api.saveCorrespondence, deleteCorrespondence: api.deleteCorrespondence, saveCustomer: api.saveCustomer, saveWorkOrder: api.saveWorkOrder, savePropaneRequest: api.savePropaneRequest, saveTreeRequest: api.saveTreeRequest, saveCottage: api.saveCottage, onShowEquipmentOnMap: (f) => { window.__shown = f; } }))`;

test("a 'no power' email shows staff which panel feeds the site and when neighbours reported it too", async () => {
  await outageSeed();
  const page = await openApp(browser, "emulator", { role: "admin", email: EMAIL });
  await page.evaluate(() => { window.__sent = []; window.sendEmail = (x) => { window.__sent.push(x); return Promise.resolve(); }; });
  await mountWithDb(page, inboxView, "(api) => api.db.sites.length === 3 && api.db.correspondence.length === 4 && api.db.customers.length === 3");
  await page.getByText("No power at the cottage").first().click();
  const hint = page.getByTestId("utility-issue-hint");
  await hint.waitFor();
  const text = await hint.innerText();
  assert.match(text, /Possible hydro problem/i);
  assert.match(text, /Staff only/i);
  assert.match(text, /Site 0101 is on Panel A \(Breaker Panel, near site 0102\) ← T1\./);
  assert.match(text, /1 other site is on it/);
  assert.match(text, /2 sites on Panel A reported a hydro problem within 12 hours \(0101, 0102\)/);
  await hint.getByRole("button", { name: "Show on map" }).first().click();
  assert.deepEqual(await page.evaluate(() => ({ u: window.__shown.utility, id: window.__shown.equipmentId })), { u: "hydro", id: "pa" });

  // Nothing about the panel goes into a reply, and nothing was sent.
  const boxes = await page.locator("textarea").evaluateAll((els) => els.map((e) => e.value).join(" "));
  assert.doesNotMatch(boxes, /Panel|T1/);
  assert.deepEqual(await page.evaluate(() => window.__sent), []);

  // A hydro bill question isn't an outage; a sewer email with no sewer
  // equipment set up shows nothing either.
  await page.getByText("Question about my hydro bill").first().click();
  await page.getByText("Can you explain the usage?").last().waitFor();
  assert.equal(await page.getByTestId("utility-issue-hint").count(), 0);
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});

test("Show on map opens the right service with that piece selected, with its location", async () => {
  await outageSeed();
  const page = await openApp(browser, "emulator", { role: "office", email: EMAIL });
  await mountWithDb(page, mapView(false).replace("onCreateWorkOrder: () => {} }", `onCreateWorkOrder: () => {}, focus: { utility: "hydro", equipmentId: "pb", ts: 1 } }`), "(api) => api.db.sites.length === 3");
  const panel = page.getByTestId("equipment-panel");
  await panel.getByText("Panel B").first().waitFor();
  assert.ok(await panel.getByText("Grey box behind the laundry").isVisible());
  assert.equal(await page.getByRole("button", { name: "Hydro", exact: true }).getAttribute("aria-pressed"), "true");
  await page.close();
});
