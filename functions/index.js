const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const WEBHOOK_SECRET = defineSecret("WINTERIZING_WEBHOOK_SECRET");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ZOHO_CLIENT_ID = defineSecret("ZOHO_CLIENT_ID");
const ZOHO_CLIENT_SECRET = defineSecret("ZOHO_CLIENT_SECRET");
const ZOHO_REFRESH_TOKEN = defineSecret("ZOHO_REFRESH_TOKEN");

// Confirmed correct via live requests against both the accounts/token
// server and the Mail REST API itself (a real GET /api/accounts response
// came back from here, not a routing error) - the org's Zoho DC is Canada.
const ZOHO_ACCOUNTS_DOMAIN = "zohocloud.ca";
const ZOHO_MAIL_DOMAIN = "zohocloud.ca";

// service@qicampark.com's own Zoho Mail account ID (confirmed via a live
// GET /api/accounts call authorized directly as that mailbox - it matches
// what Zoho Flow's "Account" trigger variable sends, which was correct
// all along). The earlier failures here were about OAuth identity, not
// this ID: the Self Client credentials below are authorized as
// service@qicampark.com itself, not as a delegate/personal account, which
// is what actually made the Mail REST API calls start working. Hardcoded
// since this is a single fixed mailbox for the org.
const ZOHO_MAIL_ACCOUNT_ID = "50669000000002002";

const VALID_ROLES = ["admin", "manager", "salesmanager", "accounting", "office"];
const ROLES_DOC = admin.firestore().doc("campground/data");

function requireCallerIsAdmin(request) {
  const callerRole = request.auth && request.auth.token && request.auth.token.role;
  if (!request.auth || callerRole !== "admin") {
    throw new HttpsError("permission-denied", "Only an Admin can change roles.");
  }
}

// Counts how many *other* users currently hold the admin claim, so a caller
// can't demote or remove the last admin and lock everyone out — mirrors the
// app's own existing safety net (getUserRole treats "no admin assigned yet"
// as "everyone is admin") from the other direction.
async function otherAdminCount(excludeUid) {
  const { users } = await admin.auth().listUsers(1000);
  return users.filter((u) => u.uid !== excludeUid && u.customClaims && u.customClaims.role === "admin").length;
}

exports.setUserRole = onCall(async (request) => {
  requireCallerIsAdmin(request);

  const email = ((request.data && request.data.email) || "").trim().toLowerCase();
  const role = request.data && request.data.role;
  if (!email) throw new HttpsError("invalid-argument", "Missing email.");
  if (!VALID_ROLES.includes(role)) {
    throw new HttpsError("invalid-argument", `Role must be one of: ${VALID_ROLES.join(", ")}`);
  }

  const user = await admin.auth().getUserByEmail(email).catch(() => null);
  if (!user) {
    throw new HttpsError(
      "not-found",
      `No account found for ${email}. They need to sign in at least once before their role can be set.`
    );
  }

  const wasAdmin = user.customClaims && user.customClaims.role === "admin";
  if (wasAdmin && role !== "admin") {
    const remaining = await otherAdminCount(user.uid);
    if (remaining === 0) {
      throw new HttpsError("failed-precondition", `${email} is the last Admin — assign another Admin first.`);
    }
  }

  await admin.auth().setCustomUserClaims(user.uid, { role });
  // Mirror into the shared document so the existing "Manage Access" list (and
  // any other UI reading db.userRoles) keeps working unchanged. This write
  // uses the Admin SDK, which bypasses firestore.rules entirely — it's the
  // one trusted path allowed to touch this field; see firestore.rules.
  await ROLES_DOC.update({ [`userRoles.${email}`]: role });

  return { ok: true, email, role };
});

exports.removeUserRole = onCall(async (request) => {
  requireCallerIsAdmin(request);

  const email = ((request.data && request.data.email) || "").trim().toLowerCase();
  if (!email) throw new HttpsError("invalid-argument", "Missing email.");

  const user = await admin.auth().getUserByEmail(email).catch(() => null);
  if (user) {
    const wasAdmin = user.customClaims && user.customClaims.role === "admin";
    if (wasAdmin) {
      const remaining = await otherAdminCount(user.uid);
      if (remaining === 0) {
        throw new HttpsError("failed-precondition", `${email} is the last Admin — assign another Admin first.`);
      }
    }
    await admin.auth().setCustomUserClaims(user.uid, { role: null });
  }
  await ROLES_DOC.update({ [`userRoles.${email}`]: admin.firestore.FieldValue.delete() });

  return { ok: true };
});

// ---------------------------------------------------------------------
// Zoho Flow webhooks — mail ingest and public sign-up forms
// ---------------------------------------------------------------------
// Recovered from the live deployment and checked in here for the first
// time — these were previously only visible in the Cloud Functions
// console, invisible to this repo. No functional change from what's live;
// see git history for what's added on top afterward.

// Your own mail domains. Anything arriving with a From address on one of
// these is your own staff/system mail (a sent reply echoing back, or a
// form notification forwarded through your own inbox) - never a real
// customer, so it's always safe to skip as correspondence.
const INTERNAL_DOMAINS = ["qicampark.com", "quintesisle.ca"];

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    return v.some((item) => toBool(item));
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["yes", "true", "1", "on", "checked"].includes(s)) return true;
    if (s.startsWith("yes")) return true;
    return false;
  }
  return false;
}

function toStr(v) {
  return (v === undefined || v === null ? "" : String(v)).trim();
}

function isInternalSender(email) {
  const e = toStr(email).toLowerCase();
  if (!e || !e.includes("@")) return false;
  const domain = e.split("@")[1];
  return INTERNAL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// When mail comes from our own domain, it might be a genuine customer email
// that a staff member manually forwarded in (e.g. sales relaying a question
// to service) rather than noise. Look for a forwarded-message block and
// pull out the original sender so real customer content isn't lost.
function extractForwardedSender(plainBody) {
  const text = plainBody || "";
  const markerIdx = text.toLowerCase().indexOf("forwarded message");
  if (markerIdx === -1) return null;
  const after = text.slice(markerIdx);
  const match = after.match(/From:\s*(?:.*?<)?([\w.+-]+@[\w.-]+\.\w+)>?/i);
  return match ? match[1].toLowerCase() : null;
}

// Best-effort read on tone - flags a short label (e.g. "Urgent") on emails
// that sound frustrated/angry/urgent, so they can jump the queue instead of
// sitting in normal order. Never blocks the write: any failure here just
// means no flag, not a lost email.
async function classifyUrgency(subject, body) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY.value(),
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 20,
        system: "You read an inbound customer email to a campground's service department. Reply with a short 2-3 word flag if the tone sounds urgent, frustrated, or angry (e.g. \"Urgent\", \"Frustrated customer\"). If the tone is calm and routine, reply with exactly the word none. Output only the flag or the word none - nothing else.",
        messages: [{ role: "user", content: `Subject: ${subject}\n\n${body}`.slice(0, 4000) }]
      })
    });
    if (!response.ok) {
      console.error("Anthropic urgency classification error:", response.status, await response.text());
      return null;
    }
    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const flag = textBlock ? textBlock.text.trim() : "";
    return flag && flag.toLowerCase() !== "none" ? flag : null;
  } catch (err) {
    console.error("Failed to classify correspondence urgency:", err);
    return null;
  }
}

// Best-effort read on whether an inbound message actually expects a reply
// (a question, a service ask) vs. is just an FYI/acknowledgment (a
// thank-you, "got it", a confirmation) that only needs a lighter one-click
// Acknowledge in the app instead of the full action set. Defaults to
// needsReply=true on any failure or ambiguity, since treating a real
// request as FYI (and having it hide behind a lighter action) is a worse
// outcome than the reverse.
async function classifyNeedsReply(subject, body) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY.value(),
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        system: "You read an inbound customer email to a campground's service department. Reply with exactly the word no if the message is purely an FYI, acknowledgment, or thank-you that doesn't expect a response (e.g. \"thanks, got it\", \"sounds good\", \"no action needed\", \"just confirming we're all set\"). Reply with exactly the word yes if it asks a question, requests service, or otherwise expects a reply. If you're unsure, answer yes. Output only yes or no - nothing else.",
        messages: [{ role: "user", content: `Subject: ${subject}\n\n${body}`.slice(0, 4000) }]
      })
    });
    if (!response.ok) {
      console.error("Anthropic needs-reply classification error:", response.status, await response.text());
      return true;
    }
    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const answer = textBlock ? textBlock.text.trim().toLowerCase() : "";
    return answer !== "no";
  } catch (err) {
    console.error("Failed to classify correspondence needs-reply:", err);
    return true;
  }
}

// Strips an email's HTML source down to plain text for storage — inbound
// correspondence arrives as full HTML (tags, signature markup, entities),
// but the Correspondence thread in the app displays `body` as plain text
// by design, so it needs to be clean before it's written to Firestore.
function htmlToPlainText(html) {
  if (!html) return "";
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<meta[^>]*>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Best-effort trim of a quoted reply chain riding along under a customer's
// new message, so correspondence bodies don't grow with the whole thread's
// history on every back-and-forth. Email clients mark quoted content very
// differently (Gmail's "On ... wrote:", Outlook's "From:/Sent:/To:/Subject:"
// header block, "-----Original Message-----", leading ">" quote lines), so
// this catches the common patterns rather than guaranteeing every client -
// never call it on a message recovered via extractForwardedSender, since
// that content is the message, not a redundant quote.
function stripQuotedReplyText(text) {
  if (!text) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const isQuoteHeaderLine = /^on .{0,120} wrote:\s*$/i.test(line) || /^-{3,}\s*original message\s*-{3,}/i.test(line) || /^_{10,}\s*$/.test(line) || /^>/.test(line);
    const isOutlookHeaderBlock = /^from:\s/i.test(line) && /^(sent|date|to|subject):/i.test((lines[i + 1] || "").trim());
    if (isQuoteHeaderLine || isOutlookHeaderBlock) {
      const trimmed = lines.slice(0, i).join("\n").trim();
      return trimmed || text.trim();
    }
  }
  return text.trim();
}

// Computed in Eastern time (not the server's default UTC) so a submission
// right around midnight ET doesn't get logged under the wrong day.
function todayEasternISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const map = {};
  parts.forEach((p) => {
    map[p.type] = p.value;
  });
  return `${map.year}-${map.month}-${map.day}`;
}

exports.winterizingSignup = onRequest(
  { secrets: [WEBHOOK_SECRET], cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const providedSecret = req.get("x-webhook-secret");
    if (!providedSecret || providedSecret !== WEBHOOK_SECRET.value()) {
      res.status(401).send("Unauthorized");
      return;
    }

    const body = req.body || {};

    const entry = {
      id: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "winterizing",
      receivedAt: new Date().toISOString(),
      submittedName: toStr(body.name),
      submittedEmail: toStr(body.email),
      submittedPhone: toStr(body.phone),
      submittedSiteNumber: toStr(body.siteNumber),
      requestedDate: toStr(body.requestedDate),
      notes: toStr(body.notes),
      options: {
        dishwasher: toBool(body.dishwasher),
        washingMachine: toBool(body.washingMachine),
        fridgeWater: toBool(body.fridgeWater),
        outsideTap: toBool(body.outsideTap),
        anodeRod: toBool(body.anodeRod),
        keyAtReception: toBool(body.keyAtReception)
      }
    };

    if (!entry.submittedSiteNumber) {
      res.status(400).json({ ok: false, error: "siteNumber is required" });
      return;
    }

    try {
      await db.collection("pendingSignups").doc(entry.id).set(entry);
      res.status(200).json({ ok: true, id: entry.id });
    } catch (err) {
      console.error("Failed to write winterizing signup:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);

exports.generalServiceRequest = onRequest(
  { secrets: [WEBHOOK_SECRET], cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const providedSecret = req.get("x-webhook-secret");
    if (!providedSecret || providedSecret !== WEBHOOK_SECRET.value()) {
      res.status(401).send("Unauthorized");
      return;
    }

    const body = req.body || {};

    // Zoho Flow field mapping for this form:
    //   Name -> First Name  => firstName
    //   Name -> Last Name   => lastName
    //   Email                => email
    //   Phone                => phone
    //   Site #                => siteNumber
    //   Description of requested service => description
    const fullName = [toStr(body.firstName), toStr(body.lastName)].filter(Boolean).join(" ");

    const entry = {
      id: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "generalservice",
      receivedAt: new Date().toISOString(),
      requestedDate: todayEasternISO(),
      submittedName: fullName,
      submittedEmail: toStr(body.email),
      submittedPhone: toStr(body.phone),
      submittedSiteNumber: toStr(body.siteNumber),
      submittedDescription: toStr(body.description)
    };

    if (!entry.submittedSiteNumber) {
      res.status(400).json({ ok: false, error: "siteNumber is required" });
      return;
    }

    try {
      await db.collection("pendingSignups").doc(entry.id).set(entry);
      res.status(200).json({ ok: true, id: entry.id });
    } catch (err) {
      console.error("Failed to write general service request:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);

// Looks up a customer by checking their primary email, secondary email,
// and any additional emails manually linked over time (matchEmails).
async function findCustomerByEmail(email) {
  const target = toStr(email).toLowerCase();
  if (!target) return null;

  const [byEmail, byEmail2, byMatchEmails] = await Promise.all([
    db.collection("customers").where("email", "==", target).limit(1).get(),
    db.collection("customers").where("email2", "==", target).limit(1).get(),
    db.collection("customers").where("matchEmails", "array-contains", target).limit(1).get()
  ]);

  const hit = !byEmail.empty ? byEmail.docs[0] : !byEmail2.empty ? byEmail2.docs[0] : !byMatchEmails.empty ? byMatchEmails.docs[0] : null;

  return hit ? hit.id : null;
}

// Zoho access tokens are short-lived (~1hr); cached at module scope so a
// warm function instance reuses one instead of spending a refresh-token
// grant (rate-limited to 10 per 10 minutes) on every inbound email.
let cachedZohoToken = null; // { token, expiresAt }

async function getZohoAccessToken() {
  if (cachedZohoToken && cachedZohoToken.expiresAt > Date.now() + 60 * 1000) {
    return cachedZohoToken.token;
  }
  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN.value(),
    client_id: ZOHO_CLIENT_ID.value(),
    client_secret: ZOHO_CLIENT_SECRET.value(),
    grant_type: "refresh_token"
  });
  const response = await fetch(`https://accounts.${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token?${params.toString()}`, {
    method: "POST"
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Zoho token refresh failed: ${response.status} ${JSON.stringify(data)}`);
  }
  cachedZohoToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedZohoToken.token;
}

// Uploads a fetched attachment to the same Storage path the app's own
// outgoing-attachment flow uses (correspondence-attachments/), and builds a
// Firebase-style download URL (a long-lived access token embedded in the
// URL) matching what the client SDK's getDownloadURL() returns, so inbound
// and outgoing attachments render identically in the correspondence thread.
async function uploadAttachmentToStorage(buffer, originalName, contentType) {
  const bucket = admin.storage().bucket();
  const safeName = (originalName || "attachment").replace(/\s+/g, "_");
  const path = `correspondence-attachments/${Date.now()}-${safeName}`;
  const token = crypto.randomUUID();
  const file = bucket.file(path);
  await file.save(buffer, {
    metadata: {
      contentType: contentType || "application/octet-stream",
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

// Caps a single attachment at 25MB — comfortably above any real email
// attachment, just guarding the function's memory against something absurd.
const ZOHO_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

// GETs a Zoho Mail API path. Returns null (having logged the failure) if
// the request doesn't come back 2xx - callers treat that as "no
// attachments" rather than losing the whole correspondence entry.
async function zohoMailGet(path, accessToken) {
  const response = await fetch(`https://mail.${ZOHO_MAIL_DOMAIN}${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
  });
  if (response.ok) return response;
  console.error("Zoho Mail API request failed:", path, response.status, await response.text());
  return null;
}

// Zoho Flow's Mail trigger doesn't expose attachment content directly, only
// the folderId/messageId needed to go fetch it ourselves via the Zoho Mail
// REST API (accountId is hardcoded above - see ZOHO_MAIL_ACCOUNT_ID).
// Best-effort: any failure here (bad OAuth setup, a huge attachment, a
// transient Zoho error) is logged and skipped rather than blocking the
// correspondence entry from being written.
async function fetchZohoAttachments({ folderId, messageId }) {
  if (!folderId || !messageId) return [];
  console.log("Fetching Zoho attachments for", { folderId, messageId });
  try {
    const accessToken = await getZohoAccessToken();
    const infoResponse = await zohoMailGet(
      `/api/accounts/${ZOHO_MAIL_ACCOUNT_ID}/folders/${folderId}/messages/${messageId}/attachmentinfo`,
      accessToken
    );
    if (!infoResponse) return [];
    const infoData = await infoResponse.json();
    const items = (infoData.data && infoData.data.attachments) || [];
    console.log(`Zoho attachmentinfo returned ${items.length} attachment(s)`);

    const results = [];
    for (const item of items) {
      if (!item.attachmentId) continue;
      if (item.attachmentSize && item.attachmentSize > ZOHO_ATTACHMENT_MAX_BYTES) {
        console.error("Skipping oversized Zoho attachment:", item.attachmentName, item.attachmentSize);
        continue;
      }
      try {
        const fileResponse = await zohoMailGet(
          `/api/accounts/${ZOHO_MAIL_ACCOUNT_ID}/folders/${folderId}/messages/${messageId}/attachments/${item.attachmentId}`,
          accessToken
        );
        if (!fileResponse) continue;
        const buffer = Buffer.from(await fileResponse.arrayBuffer());
        const contentType = fileResponse.headers.get("content-type");
        const url = await uploadAttachmentToStorage(buffer, item.attachmentName, contentType);
        results.push({ url, name: item.attachmentName || "attachment" });
      } catch (err) {
        console.error("Failed to fetch/upload one Zoho attachment:", item.attachmentId, err);
      }
    }
    return results;
  } catch (err) {
    console.error("Failed to fetch Zoho attachments:", err);
    return [];
  }
}

exports.serviceCorrespondence = onRequest(
  { secrets: [WEBHOOK_SECRET, ANTHROPIC_API_KEY, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN], cors: false, timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const providedSecret = req.get("x-webhook-secret");
    if (!providedSecret || providedSecret !== WEBHOOK_SECRET.value()) {
      res.status(401).send("Unauthorized");
      return;
    }

    const body = req.body || {};

    // Zoho Flow field mapping for this trigger:
    //   From Address  => fromEmail
    //   Subject        => subject
    //   Body / Plain Text => body
    //   Folder ID      => folderId (optional - enables attachment fetching)
    //   Message ID     => messageId (optional - enables attachment fetching)
    // (Flow's "Account" variable is intentionally unused - it isn't the
    // Zoho Mail REST API's accountId; see ZOHO_MAIL_ACCOUNT_ID above.)
    const fromEmail = toStr(body.fromEmail).toLowerCase();

    if (!fromEmail) {
      res.status(400).json({ ok: false, error: "fromEmail is required" });
      return;
    }

    try {
      const plainBody = htmlToPlainText(toStr(body.body));

      // Mail from our own domains is either a reply we sent echoing back
      // through the inbox, a form notification, or a staff member manually
      // forwarding a real customer email in (e.g. sales relaying a question
      // to service). Try to recover the original sender from a forwarded
      // block before deciding to skip - that's the only case where internal
      // mail should still count as real correspondence.
      let effectiveFrom = fromEmail;
      let forwardedBy = null;
      if (isInternalSender(fromEmail)) {
        const forwardedSender = extractForwardedSender(plainBody);
        if (forwardedSender && !isInternalSender(forwardedSender)) {
          effectiveFrom = forwardedSender;
          forwardedBy = fromEmail;
        } else {
          res.status(200).json({ ok: true, skipped: true, reason: "internal-sender" });
          return;
        }
      }

      // Zoho Forms' own "someone submitted your form" notifications use this
      // boilerplate across every form on the account. They can slip through
      // the Zoho Flow sender filter, so this is a second, independent check
      // - skip writing these as correspondence even if the Flow-side filter
      // has a gap.
      const lowerBody = plainBody.toLowerCase();
      if (lowerBody.includes("has submitted the following") || lowerBody.includes("has filled out the")) {
        res.status(200).json({ ok: true, skipped: true, reason: "form-notification" });
        return;
      }

      // A staff-forwarded message's content IS the forwarded block, not a
      // redundant quote riding along under it, so only trim the reply chain
      // for a direct customer message.
      const storedBody = forwardedBy ? plainBody : stripQuotedReplyText(plainBody);

      const customerId = await findCustomerByEmail(effectiveFrom);
      const [suggestedFlag, needsReply, attachments] = await Promise.all([
        classifyUrgency(toStr(body.subject), storedBody),
        classifyNeedsReply(toStr(body.subject), storedBody),
        fetchZohoAttachments({
          folderId: toStr(body.folderId),
          messageId: toStr(body.messageId)
        })
      ]);

      const entry = {
        id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        customerId: customerId || null,
        direction: "in",
        status: "new",
        fromEmail: effectiveFrom,
        forwardedBy,
        suggestedFlag,
        needsReply,
        subject: toStr(body.subject),
        body: storedBody,
        receivedAt: new Date().toISOString(),
        attachments
      };

      await db.collection("correspondence").doc(entry.id).set(entry);
      res.status(200).json({ ok: true, id: entry.id, matched: Boolean(customerId), forwardedBy, suggestedFlag, needsReply });
    } catch (err) {
      console.error("Failed to write correspondence:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);

// ---------------------------------------------------------------------
// Generate Work Order Customer Summary (Claude API)
// ---------------------------------------------------------------------
// Called directly by logged-in staff from the app (not by Zoho Flow), so
// this verifies a Firebase Auth ID token instead of a shared webhook
// secret. Requires the ANTHROPIC_API_KEY secret to be set:
//   firebase functions:secrets:set ANTHROPIC_API_KEY

exports.generateWorkOrderSummary = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    // Verify the request comes from a logged-in staff member.
    const authHeader = req.get("Authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) {
      res.status(401).json({ ok: false, error: "Missing auth token" });
      return;
    }
    try {
      await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      res.status(401).json({ ok: false, error: "Invalid auth token" });
      return;
    }

    const rawNotes = toStr((req.body || {}).rawNotes);
    if (!rawNotes) {
      res.status(400).json({ ok: false, error: "rawNotes is required" });
      return;
    }

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system: "You turn internal campground maintenance shop notes into a short, plain-language summary a customer can read on their invoice or service report. Write 1-3 sentences, friendly and clear, no technical jargon or part numbers unless the customer would recognize them. Do not invent details that aren't in the notes. Output only the summary text, nothing else.",
          messages: [{ role: "user", content: rawNotes }]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("Anthropic API error:", response.status, errText);
        res.status(502).json({ ok: false, error: "Claude API request failed" });
        return;
      }

      const data = await response.json();
      const textBlock = (data.content || []).find((b) => b.type === "text");
      const summary = textBlock ? textBlock.text.trim() : "";

      if (!summary) {
        res.status(502).json({ ok: false, error: "No summary returned" });
        return;
      }

      res.status(200).json({ ok: true, summary });
    } catch (err) {
      console.error("Failed to generate work order summary:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);
