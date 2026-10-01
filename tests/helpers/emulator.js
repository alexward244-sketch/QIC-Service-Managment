// Direct access to the Firestore emulator for setting up and checking test
// data, bypassing the security rules (like the Admin SDK would).
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");
const { PROJECT_ID } = require("./app");

let envPromise = null;
function testEnv() {
  if (!envPromise) {
    const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
    envPromise = initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { host, port: Number(port) } });
  }
  return envPromise;
}

// A page closed by the previous test can leave a transaction (e.g. the
// invoice-number counter) holding a lock for a moment, which makes the
// emulator refuse the clear with "Transaction lock timeout". Wait and retry.
async function clearWithRetry(env, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await env.clearFirestore();
    } catch (e) {
      if (i >= tries || !/lock timeout|ABORTED/i.test(String(e && e.message))) throw e;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

async function resetData(docs = {}) {
  const env = await testEnv();
  await clearWithRetry(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [p, data] of Object.entries(docs)) await db.doc(p).set(data);
  });
}

async function readCollection(name) {
  const env = await testEnv();
  let out = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().collection(name).get();
    out = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  });
  return out;
}

async function readDoc(p) {
  const env = await testEnv();
  let out = null;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().doc(p).get();
    out = snap.exists ? snap.data() : null;
  });
  return out;
}

async function writeDoc(p, data) {
  const env = await testEnv();
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc(p).set(data); });
}

async function cleanup() {
  if (envPromise) await (await envPromise).cleanup();
}

module.exports = { resetData, readCollection, readDoc, writeDoc, cleanup };
