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
  (`serviceCorrespondence`) or straight from the Zoho inbox (`zohoInbox`),
  Zoho Sent-folder sync (`zohoSentMail`), sign-up
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
  function(s) changed. Alex deploys from two machines, so always give both,
  each as one line to paste:
  - **Windows 11 work desktop (PowerShell):**
    `cd $HOME\Documents\QIC-Service-Managment; git pull origin main; if ($?) { firebase deploy --only ... }`
  - **Chromebook laptop (Linux terminal):**
    `cd ~/QIC-Service-Managment && git pull origin main && firebase deploy --only ...`
    (folder assumed to be in the home folder - if Alex says otherwise,
    update this note).
- Explain things in plain language; Alex isn't a developer. Keep replies
  short and lead with what changed for them.
- A refresh keeps people where they were: the computer app's tab and menu
  section, the Admin settings page and the open email are kept in this
  browser tab (`useSessionState`, sessionStorage); the field app keeps its
  screen in history.state; email replies are saved as typed
  (`saveEmailDraft`). Typing in any `Modal` makes a refresh/close ask first
  (`MODALS_WITH_EDITS` + beforeunload) until it's closed.
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
- Deleted emails sit in the Trash's own "Emails" tab (the main Trash link
  opens on "Everything else"); Correspondence has a "Deleted emails" button
  that opens it.
- Opening an incoming email in the app marks its Zoho copy read
  (`markEmailReadInZoho`), so it doesn't still look new in Zoho. Needs the
  Zoho connection's update permission (same reconnect as deletes).
- Email intake is moving from Zoho Flow to reading the Zoho inbox directly
  (`zohoInbox`, every minute). Both use the same rules
  (`classifyIncomingEmail` / `saveIncomingEmail`). Until Admin > Email
  Intake's switch (`settings.emailIntakeDirect`) is on, `zohoInbox` only
  compares (ties Flow's entries to their Zoho message id, lists what Flow
  didn't bring in in `serverState/zohoInbox`) and adds nothing; once on, it
  saves `zoho_in_<messageId>` entries and the Flow webhook skips email. The
  Email Intake ignore list applies to any sender. Flow checks the inbox on a
  timer, so its copy (stamped when delivered) can be late: the compare
  matches Flow copies up to 2 hours after Zoho's time (`FLOW_LATE_MS`) and
  re-checks the "missed" list every run.
- The Zoho access token is shared through `serverState/zohoToken` (never
  readable by the app) - Zoho allows only 10 refreshes per 10 minutes.
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
  The same daily pass moves a cottage on a weekend or blocked day to the
  next workday, and a day's extras over the limit on a day - except ones
  put there on purpose ("Put it on … anyway", or moved there from a phone,
  `keepOnDay`). Weekends can't be picked: the computer offers the next
  workday (no "anyway"), the phone puts it on the Monday.
- Once auto-plan has run (`winterAutoPlaceNew`), new sign-ups go on a day
  by themselves, flagged `newOnPlan` ("New" tag + note) until someone sees
  them - so nothing slips by unnoticed.
- A new sign-up asking for a full day still goes on it when its area has
  the most cottages that day; one from the area with the fewest moves to the
  next workday with room, flagged `movedOnPlan` ("Moved from …" + the same
  notice) for the office. The customer isn't told. Only someone who didn't
  ask for that day (or an earlier one) is moved - if everyone in the smaller areas asked for
  it, the new sign-up goes to the next day instead.
- When more are on a day than fit, those who asked for the earliest date
  keep it (someone moved on from a full earlier day beats those who asked
  for this one); a tie goes to the earliest sign-up (`winterSignedUpAt`:
  the web form's time `submittedAt`, else `createdAt`) - in auto-plan,
  auto-place and the daily tidy-up.
- The park's own cottages are winterized too: "Add park cottages…" adds
  cottages on Rental Cottage sites, owned by the "QIC Inventory" customer
  record, on sites tagged "QIC Inventory", and on
  the sites of unsold, delivered QIC Inventory units (`cottageOrders` type "Display Model"; only Admin /
  Sales Manager can read those) as requests with `parkOwned`
  ("rental"/"inventory") and no customer (`winterParkCottages`). They're
  placed last on the quietest day (`winterQuietDay`), move first when a day
  is over the limit, step aside to a quiet day when a customer asks for
  their full day, get no customer emails, and aren't on the keys email.
  A rental site with no cottage record can't be winterized (requests go by
  cottage); the window offers "Create N cottage records" ("Rental cottage
  0301", rename later).
- `winterKeyList` (Cloud Function, 9am weekdays) emails reserve@qicampark.com
  the next workday's cottages (Friday → Monday) whose site's how-to doesn't
  say our master key works, so reception collects the keys. Once per day
  (`winterKeyEmails/{date sent}`); off with `settings.winterKeyEmailOff`
  (checkbox on the Plan board). "Resend keys email now" next to it
  (`resendWinterKeyList`, Admin / Service Manager) sends the list as planned
  now, even if today's already went or the daily email is off - marked
  "UPDATED" when it replaces one sent that day.
- Closed days: Thanksgiving Monday automatically, plus blocked days ticked
  "We're closed" (`winterBlockedDays[].closed`). Nothing is planned on them,
  no keys email goes out that morning, and the open day before covers
  through the next open day (we're closed Thanksgiving, so Friday's email
  covers Tuesday).
- The crew works from phones (field app → Runs → Winterizing: a Day view
  and All sign-ups). Carry-over and auto-place run from there too
  (`useWinterAutoMoves`), so they don't depend on someone opening the
  computer screen.
- Section maps: the Plan board's "Map" on a day prints each section's map
  (`maps/*.jpg`, `WINTER_MAPS` pins) with that day's cottages circled by how
  they're winterized - blue B bypass, orange I inside, green D drain tap,
  split ring for two, grey ? no how-to - plus the list. "Section map" prints
  a whole section (Pebble Beach / By the Woods days). Cut from the park's
  vector map PDF with `tools/winter-maps/` (see its README). Pins match
  site numbers without leading zeros (`winterMapKey`).
- Winterizing → Report (`WinterizingReport`): how many cottages were marked
  done (by `completedDate`) per day, per week (Mon-Fri) and for the season
  (per week + season total), with a column per section and totals. Counts
  only, no site list. Printable; past seasons picked by year.
- Admin > Settings > Files > Storage (`StoragePane`) keeps files for any
  use: the park's large map PDF (`maps/park-map.pdf`) and the section maps
  (open / print / download). Add future files there.
- How to winterize each cottage comes from Alex's master list, kept on the
  site as `winterHowTo { code, note, masterKey }` (Winterizing → "How-to
  list…" imports the Excel; edit one on the checklist). Codes: BP = bypass,
  tool connects outside; IN = tool connects inside at the KT/K kitchen or
  BT bathroom sink, by the W window / PD patio door / FD front door / SR
  sunroom / D door; DT drain tap; OD on-demand hot water heater; (ot)
  outside tap; Master X = our master key works. Unknown bits (e.g.
  "cz1010") show as written - don't guess at them.

**Incoming**
- The Incoming tab (`IncomingView`) lists every request waiting on us: new
  incoming emails/voicemails (not FYIs), website sign-ups (service, propane,
  winterizing) and calls/walk-ins logged there (correspondence `source`
  "phone"/"walkin"). Grouped: Needs a work order / Propane·Trees·Winterizing
  / About an existing job / Just needs an answer, one main button each.
  Sign-ups use the same review forms as their own screens. It's in the
  menu's "Today" group (`SERVICE_NAV_GROUPS`, not just `TABS`), and the
  Dashboard's "Sign-Ups Needing Review" card opens it.
- Website service requests are read by Claude on arrival
  (`generalServiceRequest` runs `triageCorrespondence`, saved as the
  sign-up's `triage`): the draft work order's title and priority come from
  it, and the appliance is guessed from the words (`guessAppliance`). If
  Claude can't be reached the request is saved without it.
- The Service Requests tab is hidden (taken out of `TABS` and the menu);
  `GeneralServiceView` is still in the code until Alex says to delete it.
- A website form confirmed for a customer (from anywhere) is saved in their
  correspondence as `correspondence/webform_<sign-up id>` (handled, linked to
  what it made) so a reply to it reads in order. Web forms and logged calls
  never touch Zoho (`notFromZoho`).

**Work orders**
- Statuses: Open, In Progress, Pending, Completed. Pending is for jobs booked
  well ahead and needs a `startDate`. Pending jobs stay out of the open /
  urgent / overdue counts, the nav badge and the crew's lists (`woActive`)
  until someone moves them to In Progress - never automatically.
- Reminders: a month, two weeks, a week, two days and the day before the
  start date - weekends included, the park is open - (only those still ahead
  when it was set, `pendingSince`), in the morning
  summary on those days and the start date only (not daily), and as a pop-up
  (`PendingJobsPrompt`) for Admins and Service Managers: each person answers
  their own ("Not yet" is saved per person in `reminderSeen`), one nobody
  saw (app not opened that day) shows next time, and it's daily once the start date has
  come. Changing the start date (pop-up or form) resets the reminders.

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

**Cottages**
- The serial number is becoming the cottage's main ID (like a VIN); most
  don't have one yet, so it isn't required. Serials are compared with
  `serialKey` (ignores case, spaces, dashes); a duplicate gets a warning.
  The Cottages tab's "Missing serial #" button lists the ones left to fill in.
- A sale goes through Transfer Ownership (records it in `transferHistory`
  with the date). Adding a site someone else owns, or removing a site with a
  cottage, on the customer form shows "Is this a sale?" with a "Transfer
  Ownership instead" button - a warning, not a block.
- Ownership transfers (on the site's `transferHistory`) carry `cottageId`;
  match them with `transferIsForCottage`, not by name, so a rename keeps
  the history.
- A cottage can live off a site (sold out of the park) and still get work
  orders. Its owner is then `ownerCustomerId` (on a site, owners come from
  the site) - use `cottageOwners`. Leaving a site, it takes its transfer
  history along (`cottage.transferHistory`); read it with
  `cottageTransferHistory`. A new unit sold off-site gets a cottage record.
- "Scan nameplate" (cottage page, also in the field app) sends a photo of
  the spec plate to `readCottageNameplate` (Claude reads it; nothing is
  saved server-side). Staff check it, then it fills serial/model/year/
  maker and the factory appliances. An appliance already filled in isn't
  overwritten unless ticked (it may have been replaced since the factory).
  The boxed sideways "ISSUE NO." on the plate is not the serial. Photo kept
  at `cottage-photos/{cottageId}/` (`nameplatePhoto`). It also takes a PDF
  from the cottage's file (scanned plate, spec sheet, bill of sale; under
  7 MB), sent to Claude as a document; the PDF isn't uploaded - the cottage
  notes it in `nameplateDoc` ("Details read from …" in its history).
  It reads each appliance's serial # too (Northlander's "APPLIANCES" sheet:
  PRODUCT = trade name, PLAN # = model, SIZE = unit size), the unit size
  (`unitSize`, e.g. 39' x 12') and a double-wide's second serial
  (`serialNumber2` - two boxes joined into one cottage have one per
  section; both count for the duplicate-serial warning).
- Cottages tab: list on the left, the cottage's page on the right (wide
  screens; a pop-up on narrow ones). Top boxes are just total cottages and
  "with serial #" - Alex didn't want more. The page shows serial/model/
  year/maker in their own boxes, appliances, owners and a history timeline
  (`cottageHistory`: work orders + invoice, winterizing, propane, trees,
  quotes, sunspace, ownership, nameplate scan).
- Clicking an appliance opens its card; "+ Work order for this …" starts a
  work order tagged `applianceId`. When a tagged work order is completed it
  goes in that appliance's service log by itself, once
  (`logWorkOrderToAppliance` in `saveWorkOrder`); untagged ones still get
  the "Log to an Appliance?" prompt.

**Customers tab**
- First view is a table with filters (Needs a reply, Open work orders, No
  email on file, each area). Clicking a customer opens their full page
  (`CustomerPage`); "← All customers" goes back with the filter kept.
- The page: contact, cottage cards, "Needs attention", `notes` (a free
  text field on the customer - gate codes, pets, "call first"), and one
  history (`customerHistory`) with All / Emails / Work / Bills & invoices.
  Every line opens its item. An email still waiting (`customerNeedsReply`)
  shows opened with the reply box under it; sending marks it handled.
- Office sees invoices and hydro bills (view + print) but can't edit
  invoices - same as before (firestore.rules). Other screens still use the
  older `CustomerDetailModal` pop-up.

**Forms**
- Saves replace the whole Firestore document, so every edit form spreads
  the original record first (`...initial && initial.id ? initial : {}`)
  and fields it doesn't show (a sign-up's plan date, a customer's extra
  emails, a quote's work order link, a cottage's appliances) survive. Do
  the same in any new form.

**Invoices**
- Account numbers (sales/labour accounts) are kept on line items for
  accounting but not shown on the invoice form or anything customers see.
- A part's Description (Parts) is its usual customer-facing wording: adding
  the part to an invoice or quote copies it onto the line as `details`
  (shown under the part name on the form, print and email), editable there
  without changing the part ("Use the part's usual wording" puts it back).
- Shop supplies (default 5%) is a share of parts + labour + the service
  call (lines with `withServiceCall`). Older lines and the old
  shop-supplies fields stay parts + labour, so invoices already sent keep
  their totals.

**Security**
- App settings (`campground/data` `settings`) and sign-in codes
  (`loginCodes`) are Admin only (firestore.rules). Money roles may also
  change the winterizing plan's settings, everyone `coupleNamesReviewed`
  (`settingsRoleMayChange`; add a key there and in the rules if a
  non-Admin screen needs a new setting). A non-Admin's `persist()` keeps
  the saved copy of the rest (`keepLockedSettings`), so a stale screen
  can't undo an Admin's change.
- Only money roles create invoices, except the two the app makes itself:
  "Propane Fill" (workOrder) and "Anode Rod Replacement" (winterizing),
  parts only, not sent (`isAutoInvoice`).
- Cloud Functions use firebase-admin's modular imports (`getFirestore`,
  `getAuth`, `FieldValue` from `firebase-admin/firestore`...); v14 dropped
  `admin.firestore()`. Tests swap `getAuth()`'s methods in place.

## Ideas parked for later

- Auto-deploy Cloud Functions from GitHub Actions on merge (needs a Firebase
  deploy key as a GitHub secret) — Alex wants this eventually.
- "Add park cottages…" for the Service Manager: unsold QIC Inventory units
  come from `cottageOrders`, which only Admin / Sales Manager can read, so a
  Service Manager's list misses them. Plan: let them look up just the unsold
  delivered display models' sites (rules change + deploy), not the rest of
  the sales records. Alex said to remind him another time (Oct 2026).
