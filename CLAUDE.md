# QIC Service Management — notes for Claude

The Quinte's Isle Campark (QIC) service app: a Firebase web app for staff
(work orders, correspondence, hydro, winterizing, propane, invoices…).
Alex is the owner and the person you're working with; Tim
(tim@quintesisle.ca) is the boss.

## Where things live

- `index.html` — the whole app (React via `React.createElement`, no JSX, no
  build step). Served by GitHub Pages from `main`, so a merge is live as soon
  as the page reloads — **no deploy for app changes**.
- `functions/index.js` — Cloud Functions (v2): email intake from Zoho Flow
  (`serviceCorrespondence`), Zoho Sent-folder sync (`zohoSentMail`), sign-up
  forms, roles, morning summary, Claude triage. **Changes here need a
  deploy that Alex runs.**
- `firestore.rules`, `storage.rules` — security rules (also deployed by Alex).
- `tests/` — Node test runner + Playwright + Firebase emulator. See
  `tests/README.md`.

## How we work

- Alex describes a problem or idea → build it, test it, open a PR, and send
  a preview (screenshot or rendered HTML) when it's visual.
- **"merge it" means squash-merge the PR** (via `gh api`), then reset the
  working branch to the new `main` and force-push it.
- After merging anything in `functions/` or the rules, give Alex the exact
  commands to copy and paste, e.g.:
  ```
  git pull origin main
  firebase deploy --only functions:serviceCorrespondence
  ```
  (`firebase deploy --only firestore:rules` for rules.) Name the specific
  function(s) changed. Alex deploys from a laptop or a Windows 11 work
  desktop (PowerShell), so always start the commands with
  `cd $HOME\Documents\QIC-Service-Managment` (the desktop's copy).
- Explain things in plain language; Alex isn't a developer. Keep replies
  short and lead with what changed for them.
- Alex reviews on desktop; phone layouts matter for field staff screens
  (`useIsMobile()` = under 640px), not for accounting/review pages.

## Running the tests

The session start hook (`.claude/hooks/session-start.sh`) installs
everything and sets `CHROMIUM_PATH` and `PATH` for cloud sessions.

```
cd tests && npm test                      # everything (a few minutes)
# one file, from the repo root:
firebase emulators:exec --only firestore,storage --project demo-qic "node --test --test-concurrency=1 tests/hydro.test.js"
```

- Never run `npx playwright install`; use the container's Chromium
  (`CHROMIUM_PATH=/opt/pw-browsers/chromium`).
- Test files share one emulator — always `--test-concurrency=1`.
- `openApp(browser, "stub")` pages have no Tailwind; for screenshots, inject
  compiled CSS (build with the Tailwind CLI against `index.html`).
- In tests, `window.sendEmail = …` can be overridden (it's a global function).
- Run the full suite before opening a PR; CI runs it again on the PR.

## Business rules (don't undo these)

**Correspondence / email intake**
- Never block Tim's emails — only skip the automatic website form notices.
- Voicemails (phone system emails) never link to a customer.
- Mail from our own domain with a "Re:" subject is a reply, never a
  forward (it used to be misfiled as a new email from the customer).
- service@qicampark.com is the inbox's own address (skipped sender). A reply
  or forward sent from it (in Zoho) echoing back in is always skipped -
  `zohoSentMail` records it under the person it went to.
- Our own addresses (@qicampark.com, @quintesisle.ca) never match or link
  to a customer, even if one was saved on a customer record.
- Zoho's `sentDateInGMT` is off by hours — use `receivedTime`.
- No bulk delete in Correspondence; every message has its own Delete.
- Deleting an email in the app moves its Zoho copy to Zoho's Trash
  (`trashEmailInZoho`); an email moved to Zoho's Trash is removed from the
  app (`zohoSentMail` checks Trash), so nobody answers it twice.
- Displayed bodies go through `displayEmailBody` (hides disclaimer,
  signature block, blank lines) — display only, stored body untouched.

**Hydro**
- Seasonal and 4 Season sites get readings. Seasonal: 2 reads a year plus
  sale (closing) reads; 4 Season: monthly or every two months.
- Meter digits by area: Pebble Beach (1000–1207) and By the Woods
  (1300–1336) are **all 5 digits**; Limestone South (483–575) mostly 5 with
  a couple of 4s; Front of Park (1–256, A–D, K1–K5) mostly 4 with 2–3 5s;
  4 Season (400–470) is **mixed**.
- Readings keep the typed text (`readingText`) so leading zeros survive.
- A reading below the last billed one is an under-read (over-read last
  bill), not a rollover, when the "rollover" would exceed half the meter's
  range → "Hold until it passes …". Keep this quiet from the customer.
- Invoice numbers carry the year and restart each January: INV-26-0010,
  INV-27-0001; hydro bills the same (HYD-26-0001), separate from service
  invoices. Payments are tracked in the accounting software, not the app.
- The bill must show previous and current readings (with dates) and usage.

**Winterizing**
- Planning is weekdays only, from the season start (`winterSeasonStart`),
  up to `winterDailyLimit` (25) a day; `winterBlockedDays` are kept free of
  sign-ups (Pebble Beach / By the Woods are in their fee and don't sign up).
- Auto-plan honours a customer's requested date when there's room; a rain
  day pushes that day and after back a workday; cottages not finished on
  their day move to the next workday on their own (`carryOverWinter`).
- Once auto-plan has run (`winterAutoPlaceNew`), new sign-ups go on a day
  by themselves, flagged `newOnPlan` ("New" tag + note) until someone sees
  them - so nothing slips by unnoticed.
- A new sign-up asking for a full day still goes on it when its area has
  the most cottages that day; one from the area with the fewest moves to the
  next workday with room, flagged `movedOnPlan` ("Moved from …" + the same
  notice) for the office. The customer isn't told. Someone who asked for
  that day is only moved if everyone in the smaller areas asked for it.
- `winterKeyList` (Cloud Function, 9am weekdays) emails reserve@qicampark.com
  the next workday's cottages (Friday → Monday) whose site's how-to doesn't
  say our master key works, so reception collects the keys. Once per day
  (`winterKeyEmails/{day}`); off with `settings.winterKeyEmailOff` (checkbox
  on the Plan board).
- The crew works from phones (field app → Runs → Winterizing: a Day view
  and All sign-ups). Carry-over and auto-place run from there too
  (`useWinterAutoMoves`), so they don't depend on someone opening the
  computer screen.
- How to winterize each cottage comes from Alex's master list, kept on the
  site as `winterHowTo { code, note, masterKey }` (Winterizing → "How-to
  list…" imports the Excel; edit one on the checklist). Codes: BP = bypass,
  tool connects outside; IN = tool connects inside at the KT/K kitchen or
  BT bathroom sink, by the W window / PD patio door / FD front door / SR
  sunroom / D door; DT drain tap; OD on-demand hot water heater; (ot)
  outside tap; Master X = our master key works. Unknown bits (e.g.
  "cz1010") show as written - don't guess at them.

**Parts**
- Each part is its own document in the `parts` collection (not in
  campground/data). `persist()` writes only parts a screen changed, stock
  changes go as `FieldValue.increment` (`withStockChange` / `_stockDelta`),
  and a part is deleted only when moved to Trash in the same save. An old
  copy on a device that lost signal once wiped everyone's SKUs - don't go
  back to writing the whole list.

**Sites**
- Site numbers are written with 4 digits (1 -> 0001, 412A -> 0412A); letter
  sites A-D are 000A-000D; K1-K5 and QIC Facility sites unchanged -
  `formatSiteNumber` on save. Compare site
  numbers with `sameSiteNumber` / `signupSiteKey` (server: `matchSiteKey`),
  never with `===`, so "site 20" still finds 0020.

**Customers**
- Couple names: same last name → "Wayne & Yolande, McKinnon"; two last
  names → "Chris & Debbie Knox & Roberston".
- No "(site)" in customer display names.
- Phone numbers are stored as plain digits (6135550148) - `normalizePhone`
  in `saveCustomer` and bulk add; numbers with words ("ext 2") are left as
  typed.

**Invoices**
- Account numbers (sales/labour accounts) are kept on line items for
  accounting but not shown on the invoice form or anything customers see.

## Ideas parked for later

- Auto-deploy Cloud Functions from GitHub Actions on merge (needs a Firebase
  deploy key as a GitHub secret) — Alex wants this eventually.
