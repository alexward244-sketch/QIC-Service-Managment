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

async function resetData(docs = {}) {
  const env = await testEnv();
  await env.clearFirestore();
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

async function cleanup() {
  if (envPromise) await (await envPromise).cleanup();
}

module.exports = { resetData, readCollection, readDoc, cleanup };
