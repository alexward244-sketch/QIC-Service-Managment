// firestore.rules and storage.rules, checked role by role against the
// emulator. "noRole" is a signed-in account no Admin has given a role.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");

const ROOT = path.resolve(__dirname, "..");
const ROLES = ["admin", "manager", "accounting", "office", "salesmanager"];
let env;

before(async () => {
  const [fsHost, fsPort] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
  const [stHost, stPort] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199").split(":");
  env = await initializeTestEnvironment({
    projectId: "demo-qic-rules",
    firestore: { rules: fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8"), host: fsHost, port: Number(fsPort) },
    storage: { rules: fs.readFileSync(path.join(ROOT, "storage.rules"), "utf8"), host: stHost, port: Number(stPort) }
  });
});
after(async () => { await env.cleanup(); });

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc("campground/data").set({ settings: {}, userRoles: { "a@x.com": "admin" } });
    for (const c of ["workOrders", "customers", "correspondence", "pendingSignups", "sites", "dailySummaries"]) await db.doc(`${c}/x`).set({ id: "x", note: "" });
    await db.doc("invoices/i1").set({ id: "i1", lineItems: [{ quantity: 1, unitPrice: 85 }], notes: "" });
    await db.doc("deals/d1").set({ id: "d1" });
    await db.doc("hydroReadings/h1").set({ id: "h1", reading: 100 });
    await db.doc("serverAlerts/a1").set({ count: 1 });
    await db.doc("aiUsage/u1").set({ count: 1 });
  });
}
const as = (role) => role === "signedOut" ? env.unauthenticatedContext().firestore() : env.authenticatedContext("u-" + role, role === "noRole" ? {} : { role }).firestore();
async function allowed(role, op) {
  try { await op(as(role)); return true; } catch (e) { return false; }
}

test("staff roles can use everyday data; accounts without a role and signed-out visitors can't", async () => {
  await seed();
  for (const role of ROLES) {
    assert.ok(await allowed(role, (db) => db.doc("workOrders/x").get()), `${role} read work orders`);
    assert.ok(await allowed(role, (db) => db.doc("workOrders/new").set({ id: "new", title: "t" })), `${role} create work order`);
    assert.ok(await allowed(role, (db) => db.doc("customers/x").update({ note: "hi" })), `${role} edit customer`);
    assert.ok(await allowed(role, (db) => db.doc("campground/data").update({ settings: { a: 1 } })), `${role} save settings`);
  }
  for (const role of ["noRole", "signedOut"]) {
    for (const c of ["workOrders", "customers", "correspondence", "pendingSignups", "sites", "invoices", "dailySummaries"]) {
      assert.equal(await allowed(role, (db) => db.doc(`${c}/x`).get()), false, `${role} must not read ${c}`);
    }
    assert.equal(await allowed(role, (db) => db.doc("workOrders/new").set({ id: "new" })), false, `${role} must not create work orders`);
    assert.equal(await allowed(role, (db) => db.doc("campground/data").get()), false, `${role} must not read settings`);
  }
});

test("nobody can change roles from the app", async () => {
  await seed();
  for (const role of ROLES) {
    assert.equal(await allowed(role, (db) => db.doc("campground/data").update({ "userRoles.me@x.com": "admin" })), false, `${role} changed userRoles`);
  }
});

test("money, sales, hydro and alerts are limited to the right roles", async () => {
  await seed();
  const expect = async (desc, op, who) => {
    for (const role of [...ROLES, "noRole"]) assert.equal(await allowed(role, (db) => op(db, role)), who.includes(role), `${desc}: ${role}`);
  };
  // A different amount for each role, so every attempt is a real change.
  await expect("change an invoice amount", (db, role) => db.doc("invoices/i1").update({ lineItems: [{ quantity: 1, unitPrice: 100 + [...ROLES, "noRole"].indexOf(role) }] }), ["admin", "manager", "accounting"]);
  await expect("add a note to an invoice", (db, role) => db.doc("invoices/i1").update({ notes: "note from " + role }), ROLES);
  await expect("read deals", (db) => db.doc("deals/d1").get(), ["admin", "salesmanager"]);
  await expect("correct a hydro reading", (db, role) => db.doc("hydroReadings/h1").update({ reading: 200 + [...ROLES, "noRole"].indexOf(role) }), ["admin", "accounting"]);
  await expect("read server alerts", (db) => db.doc("serverAlerts/a1").get(), ["admin", "manager"]);
  await expect("read AI usage counters", (db) => db.doc("aiUsage/u1").get(), []);
});

test("file storage needs a staff role", async () => {
  const st = (role) => env.authenticatedContext("s-" + role, role === "noRole" ? {} : { role }).storage();
  await assertSucceeds(st("office").ref("correspondence-attachments/a.txt").putString("hi"));
  await assertSucceeds(st("admin").ref("correspondence-attachments/a.txt").getMetadata());
  await assertFails(st("noRole").ref("correspondence-attachments/b.txt").putString("hi"));
  await assertFails(st("noRole").ref("correspondence-attachments/a.txt").getMetadata());
});
