// The Cloud Functions in functions/index.js: web forms, email intake,
// sign-up matching, role changes, AI usage limits and problem alerts.
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { fns, db, claude, emails, auth, clearData, callWebhook, call } = require("./helpers/functions");

beforeEach(async () => {
  await clearData();
  await db.doc("campground/data").set({ settings: {}, userRoles: { "boss@qicampark.com": "admin", "boss2@qicampark.com": "admin", "mgr@qicampark.com": "manager" } });
});
after(async () => { await db.terminate(); });

const all = async (c) => (await db.collection(c).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

test("web forms need the secret key; a wrong key is recorded without emailing", async () => {
  const res = await callWebhook(fns.winterizingSignup, { name: "Jane", siteNumber: "42" }, "wrong");
  assert.equal(res.statusCode, 401);
  assert.equal((await all("pendingSignups")).length, 0);
  const alerts = await all("serverAlerts");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].source, "webhookRejected");
  assert.equal(emails.length, 0);
});

test("a winterizing sign-up is saved for review", async () => {
  const res = await callWebhook(fns.winterizingSignup, { name: "Jane Doe", email: "jane@x.com", phone: "555", siteNumber: "42", requestedDate: "2026-10-20", dishwasher: "yes" });
  assert.equal(res.statusCode, 200);
  const [p] = await all("pendingSignups");
  assert.equal(p.type, "winterizing");
  assert.equal(p.submittedSiteNumber, "42");
  assert.equal(p.submittedName, "Jane Doe");
});

test("a sign-up with no site number isn't lost silently: Admins are emailed once a day", async () => {
  await callWebhook(fns.generalServiceRequest, { firstName: "Sam", lastName: "Lee", email: "sam@x.com", description: "Leak" });
  await callWebhook(fns.generalServiceRequest, { firstName: "Al", email: "al@x.com" });
  const [alert] = await all("serverAlerts");
  assert.equal(alert.source, "generalServiceRequest");
  assert.equal(alert.count, 2);
  assert.deepEqual(emails.map((e) => e.to).sort(), ["boss2@qicampark.com", "boss@qicampark.com"], "one email per Admin, not per occurrence");
  assert.match(emails[0].message, /Sam Lee, sam@x\.com/);
});

test("incoming email: forwards keep their content, staff mail comes in, our own replies are skipped", async () => {
  const send = (fromEmail, subject, body) => callWebhook(fns.serviceCorrespondence, { fromEmail, subject, body });
  await send("jane@gmail.com", "Fwd: Deck quote", "See below\n\n---------- Forwarded message ---------\nFrom: Bob <bob@builders.ca>\nDate: Mon\nSubject: Deck quote\n\nThe deck needs 3 new joists.");
  await send("jane@gmail.com", "Re: Propane", "Tuesday works.\n\nOn Mon, QIC Service <service@qicampark.com> wrote:\n> When works?");
  await send("sales@qicampark.com", "FW: Leaky roof", "Service - see below.\n\nFrom: Tom Smith [mailto:tom@hotmail.com]\nSent: Monday\nTo: Sales\nSubject: Leaky roof\n\nRoof on site 42 is leaking.");
  await send("sales@qicampark.com", "Site 12", "Please call the Smiths about their deck.");
  const skipped = await send("service@qicampark.com", "Re: Deck", "Thanks!");
  assert.equal(skipped.body.reason, "skipped-sender");
  const mail = await all("correspondence");
  const by = (pred) => mail.find(pred);
  assert.match(by((m) => m.subject === "Fwd: Deck quote").body, /3 new joists/, "a customer's forward keeps the forwarded part");
  assert.equal(by((m) => m.subject === "Re: Propane").body, "Tuesday works.", "a normal reply is still trimmed");
  const fwd = by((m) => m.subject === "FW: Leaky roof");
  assert.equal(fwd.fromEmail, "tom@hotmail.com");
  assert.equal(fwd.forwardedBy, "sales@qicampark.com");
  assert.equal(by((m) => m.subject === "Site 12").fromStaff, true);
  assert.equal(mail.length, 4);
});

test("incoming email: a reply from an address we've written to joins that customer's thread", async () => {
  await db.doc("customers/c1").set({ name: "Brenda Ferguson", email: "brenda@home.ca", siteIds: [] });
  // Our reply to her web-form request, linked to her once the request was matched.
  await db.doc("correspondence/out1").set({ id: "out1", direction: "out", toEmail: "Brenda.F@gmail.com", customerId: "c1", subject: "Re: your service request", receivedAt: "2026-09-30T12:00:00Z" });
  const res = await callWebhook(fns.serviceCorrespondence, { fromEmail: "brenda.f@gmail.com", subject: "Re: your service request", body: "Thursday works." });
  const saved = (await all("correspondence")).find((m) => m.id === res.body.id);
  assert.equal(saved.customerId, "c1");
  // Someone we've never linked stays unlinked.
  const other = await callWebhook(fns.serviceCorrespondence, { fromEmail: "stranger@x.com", subject: "Hi", body: "hello" });
  assert.equal((await all("correspondence")).find((m) => m.id === other.body.id).customerId, null);
});

test("incoming email: a website contact form, forwarded by a coworker, is filed under the person who filled it in", async () => {
  const html = require("fs").readFileSync(require("path").join(__dirname, "fixtures", "webform-forward.html"), "utf8");
  await db.doc("customers/c9").set({ name: "Mike Hill", email: "mike@cdl4.com", siteIds: [] });
  const res = await callWebhook(fns.serviceCorrespondence, { fromEmail: "jayden@qicampark.com", subject: "Fwd: General Information/Contact Us Form", body: html });
  const saved = (await all("correspondence")).find((m) => m.id === res.body.id);
  assert.equal(saved.fromEmail, "mike@cdl4.com");
  assert.equal(saved.forwardedBy, "jayden@qicampark.com");
  assert.equal(saved.fromStaff, false);
  assert.equal(saved.customerId, "c9", "matched to the customer by the form's email");
  assert.deepEqual(saved.webForm, { name: "Mike Hill", phone: "+16134512305", siteNumber: "573", department: "Service Department" });
  assert.match(saved.body, /^Website contact form\nName: Mike Hill\nEmail: mike@cdl4.com/);
  assert.match(saved.body, /LOT 573 Hi its Mike Hill/);
  assert.doesNotMatch(saved.body, /confidential/, "the coworker's signature isn't kept");
  // Straight from the website's address, not forwarded: same result.
  const direct = await callWebhook(fns.serviceCorrespondence, { fromEmail: "info@quintesisle.ca", subject: "General Information/Contact Us Form", body: "Sam Lee has filled out a contact form\n\nSubmisson:\n\nName\n:\nSam, Lee\n\nEmail\n:\nsam@lee.ca\n\nMessage\n:\nSite 12 deck is loose" });
  const d = (await all("correspondence")).find((m) => m.id === direct.body.id);
  assert.equal(d.fromEmail, "sam@lee.ca");
  assert.equal(d.webForm.siteNumber, "12");
});

test("the Email Intake ignore list is respected", async () => {
  await db.doc("campground/data").set({ settings: { correspondenceSkipSenders: ["sales@qicampark.com"] }, userRoles: {} });
  assert.equal((await callWebhook(fns.serviceCorrespondence, { fromEmail: "sales@qicampark.com", subject: "Note", body: "hi" })).body.reason, "skipped-sender");
  assert.ok((await callWebhook(fns.serviceCorrespondence, { fromEmail: "service@qicampark.com", subject: "Note", body: "hello" })).body.id);
});

test("sign-up matching: staff only, Claude's answer is checked against real records and cached", async () => {
  await db.doc("sites/s42").set({ number: "42" });
  await db.doc("cottages/k42").set({ name: "Cedar", siteId: "s42" });
  await db.doc("customers/c1").set({ name: "Robert Smith", email: "rsmith@x.com", phone: "613-555-1234", siteIds: ["s42"] });
  await db.doc("pendingSignups/p1").set({ type: "winterizing", submittedName: "Bob Smith", submittedEmail: "bobby@gmail.com", submittedPhone: "6135551234" });
  assert.deepEqual(await call(fns.suggestSignupMatch, { pendingSignupId: "p1" }, ""), { error: "permission-denied" });
  claude.script.push({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ customer: "C1", siteNumber: "42", cottage: "K1", confidence: "high", reason: "Phone matches; Bob is Robert." }) }] });
  const first = await call(fns.suggestSignupMatch, { pendingSignupId: "p1" });
  assert.deepEqual([first.suggestion.customerId, first.suggestion.siteId, first.suggestion.cottageId, first.suggestion.confidence], ["c1", "s42", "k42", "high"]);
  const callsBefore = claude.calls.length;
  const again = await call(fns.suggestSignupMatch, { pendingSignupId: "p1" });
  assert.equal(again.suggestion.customerId, "c1");
  assert.equal(claude.calls.length, callsBefore, "the cached answer is reused");
  claude.script.push({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ customer: "C9", siteNumber: "999", cottage: "K9", confidence: "high", reason: "x" }) }] });
  const bogus = await call(fns.suggestSignupMatch, { pendingSignupId: "p1", refresh: true });
  assert.deepEqual([bogus.suggestion.customerId, bogus.suggestion.siteId, bogus.suggestion.cottageId], [null, null, null], "made-up references are dropped");
});

test("Claude features have an hourly limit per person and need a staff role", async () => {
  const hour = new Date().toISOString().slice(0, 13);
  await db.doc(`aiUsage/u-busy_askThePark_${hour}`).set({ count: 60 });
  assert.deepEqual(await call(fns.askThePark, { question: "hi" }, "office", "u-busy"), { error: "resource-exhausted" });
  assert.deepEqual(await call(fns.askThePark, { question: "hi" }, ""), { error: "permission-denied" });
  assert.deepEqual(await call(fns.draftCorrespondenceReply, { customerId: "c1" }, "boss"), { error: "permission-denied" }, "a made-up role is not a role");
});

test("only Admins change roles; Remove and Sign out everywhere end sessions", async () => {
  auth.users = {
    "boss@qicampark.com": { uid: "ua", customClaims: { role: "admin" } },
    "boss2@qicampark.com": { uid: "ub", customClaims: { role: "admin" } },
    "dave@qicampark.com": { uid: "ud", customClaims: { role: "office" } }
  };
  await db.doc("campground/data").set({ settings: {}, userRoles: { "boss@qicampark.com": "admin", "boss2@qicampark.com": "admin", "dave@qicampark.com": "office" } });
  assert.deepEqual(await call(fns.setUserRole, { email: "dave@qicampark.com", role: "admin" }, "office"), { error: "permission-denied" });
  assert.deepEqual(await call(fns.signOutUserEverywhere, { email: "dave@qicampark.com" }, "manager"), { error: "permission-denied" });
  await call(fns.signOutUserEverywhere, { email: "dave@qicampark.com" }, "admin");
  assert.deepEqual(auth.calls, [["revoke", "ud"]]);
  auth.calls.length = 0;
  await call(fns.removeUserRole, { email: "dave@qicampark.com" }, "admin");
  assert.deepEqual(auth.calls, [["claims", "ud", { role: null }], ["revoke", "ud"]]);
  const roles = (await db.doc("campground/data").get()).data().userRoles;
  assert.equal(roles["dave@qicampark.com"], undefined);
  assert.equal(roles["boss@qicampark.com"], "admin");
});

test("the work order summary needs a staff role and returns Claude's text", async () => {
  auth.users = { "a@x.com": { uid: "staff1", customClaims: { role: "office" } }, "b@x.com": { uid: "norole", customClaims: {} } };
  const summarize = async (token, rawNotes) => {
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await fns.generateWorkOrderSummary({ method: "POST", body: { rawNotes }, get: (h) => h.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined }, res);
    return res;
  };
  assert.equal((await summarize("norole", "x")).statusCode, 403);
  claude.script.push({ stop_reason: "end_turn", content: [{ type: "text", text: " We replaced the tap washer. " }] });
  const ok = await summarize("staff1", "Replaced washer");
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.summary, "We replaced the tap washer.");
});
