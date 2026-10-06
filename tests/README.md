# Automated tests

These run automatically on every pull request (`.github/workflows/tests.yml`),
so a PR shows ✅ or ❌ before it's merged. They never touch the real Firebase
project: everything runs against the local Firebase emulator (project
`demo-qic`), with email, Cloud Functions, Claude and Zoho faked.

| File | What it checks |
|---|---|
| `smoke.test.js` | The app's code loads; the login screen, new work order form and wrap-up window render; a new work order has no blank fields (the Sep 26–30 bug). |
| `rules.test.js` | `firestore.rules` and `storage.rules`, role by role: staff can use everyday data; accounts without a role and signed-out visitors get nothing; nobody can change roles from the app; money, sales, hydro, alerts and AI counters are limited to the right roles; device error reports can only be added by staff, in the expected shape, under their own email, and read only by Admins and Service Managers. |
| `signups.test.js` | Reviewing winterizing, propane and general service sign-ups through the real review screens: matched by phone/email + site, confirmed into a request or a numbered work order, pending entry removed, new email remembered for the customer. |
| `invoices.test.js` | An invoice created from a completed work order (as Admin and as Accounting) carries its parts as line items, the total hours (not the per-worker breakdown), the customer summary as notes, and gets a number. |
| `hydro.test.js` | First reading saved as the baseline with one activity line for the day; Office gets no Edit button; Accounting corrects a baseline without billing and the next reading's usage is recalculated; a closing reading bills the seller even after the sale is recorded. |
| `functions.test.js` | Cloud Functions with Claude, EmailJS, Zoho and Firebase Auth faked: web forms need the secret key; sign-ups saved; a sign-up with no site number emails Admins once; email intake keeps forwards, trims replies, brings in staff mail and skips our own replies and the ignore list; sign-up matching is staff-only, checked against real records and cached; Claude features have hourly limits and need a real role; only Admins change roles, and Remove / Sign out everywhere end sessions; the work order summary needs a role. |
| `parts.test.js` | Parts move from the shared record into their own collection; an out-of-date copy saving later can't wipe a SKU, and stock used on two devices both counts; deleting moves a part to Trash and restoring brings it back. |
| `errors.test.js` | Errors on staff devices are recorded for System Health: an uncaught error (once per page load, with who, phone/computer and screen), a crashed screen (and the crash screen no longer offers "Reset all data"), a failed save; Admins see them grouped, can clear them, and records over 30 days old are removed. |
| `workorders.test.js` | Work order flows through the real screens and the real rules: New Work Order on the Work Orders tab and the dashboard both save with the next number; Office can create; a failed save keeps the form open with the error; completing through the wrap-up window saves hours (two workers), parts and the note, and deducts stock; an account without a role can't read or save. |

## Running them yourself

Needs Node 22 and Java 21.

```
(cd functions && npm install)
cd tests
npm install
npx playwright install chromium
npm test
```

Takes about 30 seconds once the emulator is downloaded. The test files share one emulator, so they must run one at a time (`--test-concurrency=1` in `npm test`) - running several with plain `node --test` makes them trip over each other's data. `helpers/app.js`
builds a test copy of `index.html`; `helpers/emulator.js` sets up and reads
test data directly.
