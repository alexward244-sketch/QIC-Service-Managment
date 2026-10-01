// Loads functions/index.js for testing: the real code and the real Admin
// SDK (pointed at the Firestore emulator), with the Cloud Functions
// wrappers, secrets, Claude, Firebase Auth and outgoing HTTP faked.
const Module = require("module");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FN_MODULES = path.join(ROOT, "functions", "node_modules");
const PROJECT_ID = "demo-qic-functions";
process.env.GCLOUD_PROJECT = PROJECT_ID;

const SECRETS = { WINTERIZING_WEBHOOK_SECRET: "test-webhook-secret" };

// Claude: replies are taken from `claude.script` in order; with nothing
// scripted, a plain "routine email" triage answer is returned.
const realSdk = require(path.join(FN_MODULES, "@anthropic-ai", "sdk"));
const claude = { script: [], calls: [] };
const DEFAULT_REPLY = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ flag: null, needsReply: true, category: "service", summary: "Routine request", siteNumber: null, requestedDate: null, priority: "Medium" }) }] };
class FakeAnthropic {
  constructor() {
    const messages = {
      create: async (req) => {
        claude.calls.push(req);
        const next = claude.script.shift();
        if (next instanceof Error) throw next;
        return next || DEFAULT_REPLY;
      }
    };
    this.messages = messages;
    this.beta = { messages };
  }
}
FakeAnthropic.APIError = realSdk.APIError;

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "firebase-functions/v2/https") return { onCall: (o, f) => f || o, onRequest: (o, f) => f || o, HttpsError };
  if (request === "firebase-functions/v2/scheduler") return { onSchedule: (o, f) => f || o };
  if (request === "firebase-functions/params") return { defineSecret: (name) => ({ value: () => SECRETS[name] || "test-secret" }) };
  if (request === "@anthropic-ai/sdk") return FakeAnthropic;
  return origLoad.call(this, request, ...rest);
};

// Outgoing HTTP: EmailJS sends are recorded; anything else (Zoho) fails.
const emails = [];
global.fetch = async (url, opts) => {
  if (String(url).includes("api.emailjs.com")) {
    const body = JSON.parse(opts.body);
    emails.push({ to: body.template_params.to_email, subject: body.template_params.subject, message: body.template_params.message });
    return { ok: true, status: 200, text: async () => "OK" };
  }
  throw new Error(`No network in tests (${url})`);
};

const fns = require(path.join(ROOT, "functions", "index.js"));
const admin = require(path.join(FN_MODULES, "firebase-admin"));
const db = admin.firestore();

// Firebase Auth: a small in-memory user list.
const auth = { users: {}, calls: [] };
Object.defineProperty(admin, "auth", {
  configurable: true,
  value: () => ({
    getUserByEmail: async (email) => { if (!auth.users[email]) throw new Error("not found"); return auth.users[email]; },
    setCustomUserClaims: async (uid, claims) => { auth.calls.push(["claims", uid, claims]); },
    revokeRefreshTokens: async (uid) => { auth.calls.push(["revoke", uid]); },
    listUsers: async () => ({ users: Object.values(auth.users) }),
    verifyIdToken: async (token) => { const u = Object.values(auth.users).find((x) => x.uid === token); if (!u) throw new Error("bad token"); return { uid: u.uid, ...(u.customClaims || {}) }; }
  })
});

// Wipes the functions' test project in the emulator (a plain HTTP DELETE,
// since global fetch is faked above).
function emulatorDelete(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = require("http").request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "DELETE" }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", reject);
    req.end();
  });
}
async function clearData() {
  const host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  await emulatorDelete(`http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`);
  claude.script.length = 0;
  claude.calls.length = 0;
  emails.length = 0;
  auth.users = {};
  auth.calls.length = 0;
}

// Fake request/response for the onRequest (webhook) functions.
function request(body, headers = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method: "POST", path: "/", body, get: (name) => h[name.toLowerCase()] };
}
function response() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}
async function callWebhook(fn, body, secret = SECRETS.WINTERIZING_WEBHOOK_SECRET) {
  const res = response();
  await fn(request(body, secret ? { "x-webhook-secret": secret } : {}), res);
  return res;
}
// Calls an onCall function as a signed-in user with the given role
// ("" = no role, null = signed out). Returns the result or { error: code }.
async function call(fn, data, role = "office", uid = "u-test") {
  const auth = role === null ? null : { uid, token: role ? { role } : {} };
  try { return await fn({ auth, data }); } catch (e) { return { error: e.code || e.message }; }
}

module.exports = { fns, db, claude, emails, auth, clearData, callWebhook, call, SECRETS };
