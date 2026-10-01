// Shared helpers for tests that drive the app's real screens against the
// emulator: mount a screen with the app's own data layer (useDb), wait for
// data, and poll the database.
const { readCollection } = require("./emulator");

// factorySource: JS source of a function (api) => React element, where api
// is what useDb returns. readySource: JS source of (api) => boolean saying
// the test's data has arrived - the screen isn't shown until then, as a
// person would wait for the app to load. A save error is shown as #save-error.
async function mountWithDb(page, factorySource, readySource = "() => true") {
  await page.evaluate(([src, readySrc]) => {
    const factory = (0, eval)("(" + src + ")");
    const ready = (0, eval)("(" + readySrc + ")");
    function Host() {
      const r = useDb();
      window.__api = r;
      if (!r.db || r.loading || !ready(r)) return null;
      window.__mounted = true;
      return React.createElement(React.Fragment, null, r.error ? React.createElement("div", { id: "save-error" }, r.error) : null, factory(r));
    }
    ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Host));
  }, [factorySource, readySource]);
  await page.waitForFunction(() => window.__mounted === true, null, { timeout: 20000 });
}

async function waitFor(check, what, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const findIn = async (collection, predicate) => (await readCollection(collection)).find(predicate);

module.exports = { mountWithDb, waitFor, findIn };
