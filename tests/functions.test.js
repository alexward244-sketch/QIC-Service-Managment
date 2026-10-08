// The Cloud Functions in functions/index.js: web forms, email intake,
// sign-up matching, role changes, AI usage limits and problem alerts.
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { fns, db, claude, emails, zoho, auth, clearData, callWebhook, call } = require("./helpers/functions");

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
  assert.equal(skipped.body.reason, "own-outgoing");
  // Our own reply (sent from Zoho) echoing back with the customer's email
  // quoted under it is still ours - not a forward from the customer.
  const echo = await send("service@qicampark.com", "Re: Service Inquiry", "Hello Wayne,\n\nI can get a work order going.\n\nFrom: Wayne McKinnon <waynemckinnon5@icloud.com>\nSent: Saturday\nTo: service@qicampark.com\nSubject: Service Inquiry\n\nWater leak in the sunroom.");
  assert.equal(echo.body.reason, "own-outgoing");
  const echoFwd = await send("service@qicampark.com", "Re: Fwd: Deck quote", "Booked for Tuesday.\n\n---------- Forwarded message ---------\nFrom: Bob <bob@builders.ca>\nDate: Mon\n\nThe deck needs 3 new joists.");
  assert.equal(echoFwd.body.reason, "own-outgoing");
  // A forward sent from Zoho (service@ -> a customer) whose chain starts with
  // a coworker is ours too - it used to land in an unrelated customer's
  // conversation.
  const zohoFwd = await send("service@qicampark.com", "Fwd: Re: Quinte's Isle Campark - Winterizing Sign Up", "Hello Marquise,\n\nYou signed-up for Oct 30.\n\n============ Forwarded message ============\nFrom: Jayden Ward <jayden@qicampark.com>\nTo: service@qicampark.com\n\n============ Forwarded message ============\nFrom: Marquise Nadon <chezmarquise1@gmail.com>\nTo: <info@quintesisle.ca>\n\nI can leave a key at the front desk.");
  assert.equal(zohoFwd.body.reason, "own-outgoing");
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
  // The website's sign-up forms already arrive under Sign-ups, so their
  // notices are skipped - "a" or "the", direct or forwarded.
  const propane = "Dave Quickert has filled out a Propane Request Form\nSubmisson:\nName:Dave, Quickert\nAddress:29 Davidson Rd\nEmail:dave.q@x.com\nSite Number:1316";
  for (const [from, subject, body] of [
    ["info@quintesisle.ca", "Propane Fill Request - 1316", propane],
    ["info@quintesisle.ca", "Winterizing", "Jo Bloggs has filled out the Winterizing Sign Up Form\n\nName\n:\nJo"],
    ["jayden@qicampark.com", "Fwd: Propane Fill Request - 1316", `---------- Forwarded message ---------\nFrom: <info@quintesisle.ca>\n\n${propane}`]
  ]) {
    const r = await callWebhook(fns.serviceCorrespondence, { fromEmail: from, subject, body });
    assert.equal(r.body.reason, "form-notification", subject);
  }
  assert.equal((await all("correspondence")).length, 2, "only the two contact forms were kept");
  // The General Service Request form is a sign-up too (Service Requests),
  // even from Tim's address - but Tim's own emails still come in.
  const gsr = await callWebhook(fns.serviceCorrespondence, { fromEmail: "tim@quintesisle.ca", subject: "General Service Request Form", body: "Jill Holliday at site # has filled out the General Service Request Form\nName:Jill" });
  assert.equal(gsr.body.reason, "form-notification");
  const tim = await callWebhook(fns.serviceCorrespondence, { fromEmail: "tim@quintesisle.ca", subject: "Site 412 deck", body: "Can someone look at the deck at 412 this week?" });
  assert.ok(tim.body.id, "a normal email from Tim is kept");
});

test("incoming email: voicemails are never linked to a customer, and say who called", async () => {
  // Someone once saved the phone system's address on a customer.
  await db.doc("customers/c1").set({ name: "Bill & Susan March", email: "march@x.com", matchEmails: ["noreply@phones.example"], siteIds: [] });
  const res = await callWebhook(fns.serviceCorrespondence, { fromEmail: "noreply@phones.example", subject: "V-Mail from SUSAN MARCH (613) 438-0648 to Service Department 106", body: "You have a new voicemail from (613) 438-0648. Large branch fell on the deck between 412A and 412B." });
  const saved = (await all("correspondence")).find((m) => m.id === res.body.id);
  assert.equal(saved.customerId, null);
  assert.deepEqual(saved.voicemail, { callerName: "Susan March", callerNumber: "(613) 438-0648", to: "Service Department 106" });
  const noName = await callWebhook(fns.serviceCorrespondence, { fromEmail: "noreply@phones.example", subject: "V-Mail from (647) 469-6932 to Service Department 106", body: "You have a new voicemail from (647) 469-6932" });
  const saved2 = (await all("correspondence")).find((m) => m.id === noName.body.id);
  assert.deepEqual([saved2.customerId, saved2.voicemail.callerName, saved2.voicemail.callerNumber], [null, null, "(647) 469-6932"]);
});

test("incoming email: our own addresses never link to a customer, even if one was saved on a customer by mistake", async () => {
  await db.doc("customers/c7").set({ name: "Gary & Lynn, Callaghan", email: "gary@x.com", matchEmails: ["jayden@qicampark.com", "service@qicampark.com"], siteIds: [] });
  await db.doc("correspondence/old1").set({ id: "old1", direction: "in", fromEmail: "jayden@qicampark.com", customerId: "c7", subject: "Old", receivedAt: "2026-10-01T12:00:00Z" });
  const res = await callWebhook(fns.serviceCorrespondence, { fromEmail: "jayden@qicampark.com", subject: "Site 12", body: "Please call the Smiths about their deck." });
  const saved = (await all("correspondence")).find((m) => m.id === res.body.id);
  assert.equal(saved.fromStaff, true);
  assert.equal(saved.customerId, null);
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

// Zoho's sentDateInGMT runs ahead by the mailbox's time-zone offset.
const SHIFT = 4 * 3600e3;

test("replies sent from Zoho: a missing permission is reported in System Health", async () => {
  zoho.on = true;
  zoho.foldersStatus = 400;
  await fns.zohoSentMail();
  assert.equal((await all("correspondence")).length, 0);
  const [alert] = await all("serverAlerts");
  assert.equal(alert.source, "zohoSentMail");
  assert.match(alert.lastMessage, /re-authoriz/);
});

test("replies sent from Zoho are filed under the customer, once, and answer their waiting email", async () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  await db.collection("customers").doc("c1").set({ id: "c1", name: "Anne Lee", email: "anne@x.com" });
  await db.collection("correspondence").doc("in1").set({ id: "in1", direction: "in", status: "new", customerId: "c1", fromEmail: "anne@x.com", subject: "Leak", body: "The tap leaks", receivedAt: iso(now - 3 * 3600e3) });
  await db.collection("correspondence").doc("app1").set({ id: "app1", direction: "out", status: "handled", customerId: null, fromEmail: "service@qicampark.com", toEmail: "Bob@Y.com", subject: "Gate code", body: "It's 1234", receivedAt: iso(now - 3600e3) });
  zoho.on = true;
  zoho.sent = [
    { messageId: "m1", subject: "Re: Leak", fromAddress: "service@qicampark.com", toAddress: "&quot;Anne Lee&quot; &lt;Anne@X.com&gt;", receivedTime: String(now - 2 * 3600e3), sentDateInGMT: String(now - 2 * 3600e3 + SHIFT), hasAttachment: "0" },
    { messageId: "m2", subject: "Gate code", fromAddress: "service@qicampark.com", toAddress: "bob@y.com", receivedTime: String(now - 3600e3 + 60e3), sentDateInGMT: String(now - 3600e3 + 60e3 + SHIFT), hasAttachment: "0" },
    { messageId: "m3", subject: "Prepaid propane", fromAddress: "service@qicampark.com", toAddress: "accounting@qicampark.com", receivedTime: String(now - 1800e3), sentDateInGMT: String(now - 1800e3 + SHIFT), hasAttachment: "0" },
    { messageId: "m4", subject: "Old", fromAddress: "service@qicampark.com", toAddress: "anne@x.com", receivedTime: String(now - 48 * 3600e3), sentDateInGMT: String(now - 48 * 3600e3 + SHIFT), hasAttachment: "0" }
  ];
  zoho.content = { m1: "<div>We'll be there Tuesday.</div><div>On Mon, Anne Lee wrote:</div><div>&gt; The tap leaks</div>" };

  await fns.zohoSentMail();
  await fns.zohoSentMail();
  let corr = await all("correspondence");
  const fromZoho = corr.filter((c) => c.sentVia === "zoho");
  assert.equal(fromZoho.length, 1, "only the customer reply is added, and only once");
  assert.equal(fromZoho[0].customerId, "c1");
  assert.equal(fromZoho[0].toEmail, "anne@x.com");
  assert.equal(fromZoho[0].direction, "out");
  assert.equal(fromZoho[0].body, "We'll be there Tuesday.");
  const waiting = corr.find((c) => c.id === "in1");
  assert.equal(waiting.status, "handled");
  assert.equal(waiting.handledBy, "Replied in Zoho");
  assert.equal((await all("serverAlerts")).length, 0);

  // Emails the app sent itself (an invoice) are noted, and skipped here;
  // old notes are cleared out.
  await db.collection("appSentEmails").doc("n1").set({ toEmail: "anne@x.com", subject: "Invoice 1001", sentAt: iso(now - 9 * 60e3) });
  await db.collection("appSentEmails").doc("n-old").set({ toEmail: "anne@x.com", subject: "Invoice 900", sentAt: iso(now - 3 * 24 * 3600e3) });
  zoho.sent.unshift({ messageId: "m-inv", subject: "Invoice 1001", fromAddress: "service@qicampark.com", toAddress: "anne@x.com", receivedTime: String(now - 10 * 60e3), sentDateInGMT: String(now - 10 * 60e3 + SHIFT), hasAttachment: "0" });
  await fns.zohoSentMail();
  assert.equal((await all("correspondence")).some((c) => c.zohoMessageId === "m-inv"), false);
  assert.deepEqual((await all("appSentEmails")).map((n) => n.id), ["n1"]);

  // Later sends are picked up on the next run; an attachment gets a note.
  zoho.sent.unshift({ messageId: "m5", subject: "Your quote", fromAddress: "service@qicampark.com", toAddress: "newperson@z.com", receivedTime: String(now - 60e3), sentDateInGMT: String(now - 60e3 + SHIFT), hasAttachment: "1", summary: "Quote attached" });
  await fns.zohoSentMail();
  corr = await all("correspondence");
  const m5 = corr.find((c) => c.zohoMessageId === "m5");
  assert.equal(m5.customerId, null);
  assert.match(m5.body, /^Quote attached\n\n\(Sent with an attachment/);
  assert.equal(corr.filter((c) => c.sentVia === "zoho").length, 2);
});

test("replies sent from Zoho: entries filed with Zoho's shifted time are corrected once, and app duplicates dropped", async () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const real = now - 2 * 3600e3;
  await db.collection("customers").doc("c1").set({ id: "c1", name: "Anne Lee", email: "anne@x.com" });
  // What the first version left behind: lastSentAt (shifted), a real Zoho
  // reply and a copy of an app reply, both stamped 4 hours late.
  await db.doc("serverState/zohoSentSync").set({ lastSentAt: real + 60e3 + SHIFT });
  await db.collection("correspondence").doc("zoho_sent_r1").set({ id: "zoho_sent_r1", direction: "out", sentVia: "zoho", zohoMessageId: "r1", customerId: "c1", toEmail: "anne@x.com", subject: "Re: Leak", body: "Tuesday", receivedAt: iso(real + SHIFT), handledAt: iso(real + SHIFT), status: "handled" });
  await db.collection("correspondence").doc("app2").set({ id: "app2", direction: "out", customerId: "c1", toEmail: "anne@x.com", subject: "", body: "Hello", receivedAt: iso(real + 60e3), status: "handled" });
  await db.collection("correspondence").doc("zoho_sent_r2").set({ id: "zoho_sent_r2", direction: "out", sentVia: "zoho", zohoMessageId: "r2", customerId: "c1", toEmail: "anne@x.com", subject: "Message from QIC", body: "Hello", receivedAt: iso(real + 60e3 + SHIFT), handledAt: iso(real + 60e3 + SHIFT), status: "handled" });
  // Anne's emails the shifted reply marked handled: one before it (right),
  // one that came in an hour after it (wrong).
  await db.collection("correspondence").doc("in-before").set({ id: "in-before", direction: "in", customerId: "c1", fromEmail: "anne@x.com", subject: "Leak", receivedAt: iso(real - 3600e3), status: "handled", handledAt: iso(real + SHIFT), handledBy: "Replied in Zoho" });
  await db.collection("correspondence").doc("in-after").set({ id: "in-after", direction: "in", customerId: "c1", fromEmail: "anne@x.com", subject: "Also", receivedAt: iso(real + 3600e3), status: "handled", handledAt: iso(real + SHIFT), handledBy: "Replied in Zoho" });
  zoho.on = true;
  zoho.sent = [
    { messageId: "r2", subject: "Message from QIC", fromAddress: "service@qicampark.com", toAddress: "anne@x.com", receivedTime: String(real + 60e3), sentDateInGMT: String(real + 60e3 + SHIFT), hasAttachment: "0" },
    { messageId: "r1", subject: "Re: Leak", fromAddress: "service@qicampark.com", toAddress: "anne@x.com", receivedTime: String(real), sentDateInGMT: String(real + SHIFT), hasAttachment: "0" }
  ];

  await fns.zohoSentMail();
  await fns.zohoSentMail();
  const corr = Object.fromEntries((await all("correspondence")).map((c) => [c.id, c]));
  assert.equal(corr.zoho_sent_r1.receivedAt, iso(real));
  assert.equal(corr.zoho_sent_r1.handledAt, iso(real));
  assert.equal(corr.zoho_sent_r2, undefined, "the copy of the app's own reply is removed");
  assert.equal(corr["in-before"].status, "handled");
  assert.equal(corr["in-before"].handledAt, iso(real));
  assert.equal(corr["in-after"].status, "new");
  assert.equal(Object.keys(corr).length, 4);
  const state = (await db.doc("serverState/zohoSentSync").get()).data();
  assert.equal(state.timesRepaired, true);
  assert.ok(state.lastReceivedAt <= now);
});

test("deleting an email in the app moves its Zoho copy to Zoho's Trash", async () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  zoho.on = true;
  zoho.search = [
    { messageId: "z-leak", folderId: "inbox1", subject: "Leak", fromAddress: "Anne Lee <anne@x.com>", toAddress: "service@qicampark.com", receivedTime: String(now - 3600e3 - 20e3) },
    { messageId: "z-other", folderId: "inbox1", subject: "Other thing", fromAddress: "anne@x.com", toAddress: "service@qicampark.com", receivedTime: String(now - 3600e3) },
    { messageId: "z-old", folderId: "inbox1", subject: "Leak", fromAddress: "anne@x.com", toAddress: "service@qicampark.com", receivedTime: String(now - 30 * 24 * 3600e3) },
    { messageId: "z-fwd", folderId: "inbox1", subject: "Fwd: Deck", fromAddress: "krista@qicampark.com", toAddress: "service@qicampark.com", receivedTime: String(now - 7200e3) },
    { messageId: "z-sent", folderId: "sent1", subject: "Re: Leak", fromAddress: "service@qicampark.com", toAddress: "anne@x.com", receivedTime: String(now - 1800e3) }
  ];
  const del = (data) => call(fns.trashEmailInZoho, data);

  assert.deepEqual(await del({ direction: "in", fromEmail: "anne@x.com", subject: "Leak", receivedAt: iso(now - 3600e3) }), { ok: true, moved: 1 });
  assert.deepEqual(zoho.moved.pop(), { mode: "moveMessage", messageId: ["z-leak"], destfolderId: "trash1" }, "only the same email - not her other one or an older one");
  assert.deepEqual((await db.doc("serverState/zohoSentSync").get()).data().trashSeen, ["z-leak"], "the Trash check skips what the app already deleted");
  // A coworker's forward is in Zoho under the coworker.
  assert.deepEqual(await del({ direction: "in", fromEmail: "bob@y.com", forwardedBy: "krista@qicampark.com", subject: "Fwd: Deck", receivedAt: iso(now - 7200e3 + 5e3) }), { ok: true, moved: 1 });
  assert.equal(zoho.moved.pop().messageId[0], "z-fwd");
  // A reply sent from Zoho is found by its message id.
  assert.deepEqual(await del({ direction: "out", zohoMessageId: "z-sent", toEmail: "anne@x.com", subject: "Re: Leak", receivedAt: iso(now - 1800e3) }), { ok: true, moved: 1 });
  assert.equal(zoho.moved.pop().messageId[0], "z-sent");
  // Nothing in Zoho matches: nothing is moved.
  assert.deepEqual(await del({ direction: "in", fromEmail: "nobody@z.com", subject: "Hi", receivedAt: iso(now) }), { ok: true, moved: 0 });
  assert.equal((await all("serverAlerts")).length, 0);

  // Zoho refuses (the connection can't delete mail yet): reported.
  zoho.moveStatus = 400;
  assert.deepEqual(await del({ direction: "in", fromEmail: "anne@x.com", subject: "Leak", receivedAt: iso(now - 3600e3) }), { ok: false, reason: "not-allowed" });
  assert.equal((await all("serverAlerts"))[0].source, "zohoDelete");

  assert.equal((await call(fns.trashEmailInZoho, { subject: "Leak" }, "")).error, "permission-denied");
});

test("an email moved to Zoho's Trash is removed from the app", async () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const put = (c) => db.collection("correspondence").doc(c.id).set(c);
  await put({ id: "in-leak", direction: "in", status: "new", fromEmail: "anne@x.com", subject: "Leak", receivedAt: iso(now - 3600e3) });
  await put({ id: "in-other", direction: "in", status: "new", fromEmail: "anne@x.com", subject: "Other thing", receivedAt: iso(now - 3600e3) });
  await put({ id: "in-webform", direction: "in", status: "new", fromEmail: "carl@z.com", zohoFrom: "website@qicampark.com", subject: "Contact form", receivedAt: iso(now - 7200e3) });
  await put({ id: "zoho_sent_r1", direction: "out", sentVia: "zoho", zohoMessageId: "r1", toEmail: "anne@x.com", subject: "Re: Leak", receivedAt: iso(now - 1800e3) });
  await put({ id: "app-out", direction: "out", toEmail: "bob@y.com", subject: "Gate code", receivedAt: iso(now - 900e3) });
  zoho.on = true;
  zoho.trash = [
    { messageId: "t-leak", subject: "Leak", fromAddress: "anne@x.com", toAddress: "service@qicampark.com", receivedTime: String(now - 3600e3 - 30e3) },
    { messageId: "t-form", subject: "Contact form", fromAddress: "website@qicampark.com", toAddress: "service@qicampark.com", receivedTime: String(now - 7200e3) },
    { messageId: "r1", subject: "Re: Leak", fromAddress: "service@qicampark.com", toAddress: "anne@x.com", receivedTime: String(now - 1800e3) },
    { messageId: "t-gate", subject: "Gate code", fromAddress: "service@qicampark.com", toAddress: "bob@y.com", receivedTime: String(now - 900e3 + 30e3) },
    { messageId: "t-junk", subject: "Win a prize", fromAddress: "spam@junk.com", toAddress: "service@qicampark.com", receivedTime: String(now - 600e3) },
    { messageId: "t-ancient", subject: "Other thing", fromAddress: "anne@x.com", toAddress: "service@qicampark.com", receivedTime: String(now - 90 * 24 * 3600e3) }
  ];

  await fns.zohoSentMail();
  assert.deepEqual((await all("correspondence")).map((c) => c.id).sort(), ["in-other"]);
  assert.equal((await all("serverAlerts")).length, 0);
  // They're kept in the app's Trash, where they can be read or restored.
  const trash = (await db.doc("campground/data").get()).data().trash;
  assert.deepEqual(trash.map((t) => [t.type, t.data.id, t.deletedIn]).sort(), [["correspondence", "app-out", "Zoho"], ["correspondence", "in-leak", "Zoho"], ["correspondence", "in-webform", "Zoho"], ["correspondence", "zoho_sent_r1", "Zoho"]]);
  assert.equal(trash.find((t) => t.data.id === "in-leak").label, "Email — Leak");

  // Each trashed message is only looked at once.
  await put({ id: "in-leak", direction: "in", status: "new", fromEmail: "anne@x.com", subject: "Leak", receivedAt: iso(now - 3600e3) });
  await fns.zohoSentMail();
  assert.deepEqual((await all("correspondence")).map((c) => c.id).sort(), ["in-leak", "in-other"]);
});

test("winterizing keys: the open day before (Friday for Monday, Thanksgiving and closed days skipped), reception gets the cottages our master key doesn't open, once", async () => {
  const set = (c, id, data) => db.collection(c).doc(id).set(data);
  await Promise.all([
    set("sites", "s1", { number: "0010", section: "Front of Park", winterHowTo: { code: "IN BT FD", note: "", masterKey: false } }),
    set("sites", "s2", { number: "0009", section: "Front of Park", winterHowTo: { code: "BP", note: "", masterKey: true } }),
    set("sites", "s3", { number: "0490", section: "Limestone South" }),
    set("cottages", "k1", { name: "Willow", siteId: "s1" }),
    set("cottages", "k2", { name: "Cedar", siteId: "s2" }),
    set("cottages", "k3", { name: "Birch", siteId: "s3" }),
    set("customers", "c1", { name: "Bo Day", phone: "6135550177" }),
    // Monday the 19th: Willow (key needed), Cedar (master key works), Birch (not on the list, key at reception).
    set("winterizingRequests", "r1", { cottageId: "k1", customerId: "c1", plannedDate: "2026-10-19" }),
    set("winterizingRequests", "r2", { cottageId: "k2", plannedDate: "2026-10-19" }),
    set("winterizingRequests", "r3", { cottageId: "k3", requestedDate: "2026-10-19", options: { keyAtReception: true } }),
    set("winterizingRequests", "r4", { cottageId: "k1", plannedDate: "2026-10-19", completed: true }),
    set("winterizingRequests", "r5", { cottageId: "k1", plannedDate: "2026-10-20" })
  ]);
  // Friday Oct 16, 9am Toronto.
  await fns.winterKeyList({ scheduleTime: "2026-10-16T13:00:00Z" });
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, "reserve@qicampark.com");
  assert.equal(emails[0].subject, "Winterizing keys needed for Monday, October 19");
  assert.match(emails[0].message, /These 2 cottages are being winterized on Monday, October 19/);
  assert.match(emails[0].message, /Front of Park\n- Site 0010 · Willow · Bo Day, 6135550177\n\nLimestone South\n- Site 0490 · Birch · no owner linked \(customer said the key is at reception; not on the master list - check\)/);
  assert.doesNotMatch(emails[0].message, /Cedar/);
  // Once per day, and not at all when turned off or nothing needs a key.
  await fns.winterKeyList({ scheduleTime: "2026-10-16T13:00:00Z" });
  assert.equal(emails.length, 1);
  await fns.winterKeyList({ scheduleTime: "2026-10-19T13:00:00Z" });
  assert.equal(emails.length, 2, "Monday sends Tuesday's");
  assert.match(emails[1].subject, /Tuesday, October 20/);
  // Thanksgiving Monday (Oct 12) is closed: Friday the 9th covers it and Tuesday; nothing goes out on the Monday.
  await db.collection("winterizingRequests").doc("t1").set({ cottageId: "k1", customerId: "c1", plannedDate: "2026-10-13" });
  await fns.winterKeyList({ scheduleTime: "2026-10-12T13:00:00Z" });
  assert.equal(emails.length, 2, "closed on Thanksgiving");
  await fns.winterKeyList({ scheduleTime: "2026-10-09T13:00:00Z" });
  assert.equal(emails.length, 3);
  assert.equal(emails[2].subject, "Winterizing keys needed for Tuesday, October 13");
  // A blocked day marked closed works the same way (Wed 21st closed: Tuesday covers Thursday).
  await db.collection("winterizingRequests").doc("t2").set({ cottageId: "k1", plannedDate: "2026-10-22" });
  await db.doc("campground/data").set({ settings: { winterBlockedDays: [{ date: "2026-10-21", label: "Staff day", closed: true }] } }, { merge: true });
  await fns.winterKeyList({ scheduleTime: "2026-10-20T13:00:00Z" });
  assert.equal(emails.length, 4);
  assert.equal(emails[3].subject, "Winterizing keys needed for Thursday, October 22");
  await db.doc("campground/data").set({ settings: { winterKeyEmailOff: true } }, { merge: true });
  await db.collection("winterizingRequests").doc("r6").set({ cottageId: "k1", plannedDate: "2026-10-21" });
  await fns.winterKeyList({ scheduleTime: "2026-10-23T13:00:00Z" });
  assert.equal(emails.length, 4, "turned off");
});
