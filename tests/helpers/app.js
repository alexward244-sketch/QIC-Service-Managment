// Builds a test copy of the app (index.html's own scripts, with React and
// Firebase loaded from tests/node_modules) and opens it in headless Chromium.
//
// Two modes:
//   "stub"     - Firebase is faked; for checks that don't need a database.
//   "emulator" - the real Firebase SDK talking to the local Firestore
//                emulator (project "demo-qic", so nothing can reach the real
//                project), signed in with a test token carrying the given
//                role claim - so the real firestore.rules apply.
// Email, Cloud Functions, Storage, Auth UI and Messaging are always faked.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const MODULES = path.resolve(__dirname, "..", "node_modules");
const PROJECT_ID = "demo-qic";

function fileUrl(p) {
  return "file://" + p;
}

function appScripts() {
  const lines = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "<script>") continue;
    const body = [];
    for (i++; lines[i].trim() !== "</script>"; i++) body.push(lines[i]);
    blocks.push(body.join("\n"));
  }
  if (blocks.length < 2) throw new Error("Couldn't find the app's inline scripts in index.html");
  return blocks;
}

const STUB_PRELUDE = `
const mk=()=>{const f=function(){};return new Proxy(f,{get(t,k){if(typeof k==='symbol'||k==='then')return undefined;if(k==='toString'||k==='valueOf')return()=>'stub';return mk();},apply(){return mk();},construct(){return mk();}});};
window.__errors=[];window.addEventListener('error',e=>window.__errors.push(String(e.message)));
window.emailjs=mk();window.XLSX=mk();window.pdfjsLib=mk();
const fnObj={httpsCallable:(name)=>(data)=>window.__callable?window.__callable(name,data):Promise.reject(new Error('No Cloud Functions in tests'))};
`;

function buildHtml(mode) {
  const head = [
    `<script src="${fileUrl(path.join(MODULES, "react/umd/react.development.js"))}"></script>`,
    `<script src="${fileUrl(path.join(MODULES, "react-dom/umd/react-dom.development.js"))}"></script>`
  ];
  let prelude = STUB_PRELUDE;
  if (mode === "emulator") {
    head.push(`<script src="${fileUrl(path.join(MODULES, "firebase/firebase-app-compat.js"))}"></script>`);
    head.push(`<script src="${fileUrl(path.join(MODULES, "firebase/firebase-firestore-compat.js"))}"></script>`);
    prelude += `
const params=new URLSearchParams(location.search);
const realInit=firebase.initializeApp.bind(firebase);
firebase.initializeApp=(cfg,...rest)=>realInit({...cfg,projectId:'${PROJECT_ID}'},...rest);
const realFirestore=firebase.firestore.bind(firebase);
let fsInst=null;
const fsFn=function(){if(!fsInst){fsInst=realFirestore();const [h,p]=params.get('fs').split(':');const role=params.get('role');const token={sub:'test-user',email:params.get('email')||'tester@qicampark.com'};if(role)token.role=role;fsInst.useEmulator(h,Number(p),{mockUserToken:token});}return fsInst;};
Object.assign(fsFn,firebase.firestore);
firebase.firestore=fsFn;
const authObj=new Proxy({currentUser:{uid:'test-user',email:params.get('email')||'tester@qicampark.com'}},{get(t,k){if(k in t)return t[k];if(typeof k==='symbol'||k==='then')return undefined;return mk();}});
firebase.auth=Object.assign(()=>authObj,{GoogleAuthProvider:function(){}});
firebase.storage=()=>mk();
firebase.functions=()=>fnObj;
firebase.messaging=Object.assign(()=>mk(),{isSupported:()=>false});
`;
  } else {
    prelude += `window.firebase=new Proxy(function(){},{get(t,k){if(k==='functions')return()=>fnObj;if(typeof k==='symbol'||k==='then')return undefined;return mk();}});`;
  }
  const [first, ...rest] = appScripts();
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><div id="test"></div>${head.join("")}<script>${prelude}</script>` +
    `<script>\n${first}\n</script>` + rest.map((b) => `<script>\n${b}\n</script>`).join("") + `</body></html>`;
}

const built = {};
function harnessPath(mode) {
  if (!built[mode]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qic-tests-"));
    built[mode] = path.join(dir, `app-${mode}.html`);
    fs.writeFileSync(built[mode], buildHtml(mode));
  }
  return built[mode];
}

async function launch() {
  // CHROMIUM_PATH lets a machine with its own Chromium skip Playwright's download.
  return chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
}

// Opens the app in a fresh browser context (its own offline cache).
// opts.role: role claim for the emulator token; "" means signed in with no role.
async function openApp(browser, mode, opts = {}) {
  // opts.touch: behave like a phone (touch screen, coarse pointer).
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 1400 }, ...(opts.touch ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const q = new URLSearchParams();
  if (mode === "emulator") {
    q.set("fs", process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080");
    q.set("role", opts.role == null ? "admin" : opts.role);
    if (opts.email) q.set("email", opts.email);
  }
  await page.goto(fileUrl(harnessPath(mode)) + (mode === "emulator" ? "?" + q.toString() : ""));
  page.pageErrors = pageErrors;
  page.close = ((orig) => async () => { await orig.call(page); await context.close(); })(page.close);
  return page;
}

module.exports = { launch, openApp, PROJECT_ID };
