# Automated tests

These run automatically on every pull request (`.github/workflows/tests.yml`),
so a PR shows ✅ or ❌ before it's merged. They never touch the real Firebase
project: everything runs against the local Firebase emulator (project
`demo-qic`), with email, Cloud Functions, Claude and Zoho faked.

| File | What it checks |
|---|---|
| `smoke.test.js` | The app's code loads; the login screen, new work order form and wrap-up window render; a new work order has no blank fields (the Sep 26–30 bug). |
| `rules.test.js` | `firestore.rules` and `storage.rules`, role by role: staff can use everyday data; accounts without a role and signed-out visitors get nothing; nobody can change roles from the app; money, sales, hydro, alerts and AI counters are limited to the right roles. |
| `workorders.test.js` | Work order flows through the real screens and the real rules: New Work Order on the Work Orders tab and the dashboard both save with the next number; Office can create; a failed save keeps the form open with the error; completing through the wrap-up window saves hours (two workers), parts and the note, and deducts stock; an account without a role can't read or save. |

## Running them yourself

Needs Node 22 and Java 21.

```
cd tests
npm install
npx playwright install chromium
npm test
```

Takes about 15 seconds once the emulator is downloaded. `helpers/app.js`
builds a test copy of `index.html`; `helpers/emulator.js` sets up and reads
test data directly.
