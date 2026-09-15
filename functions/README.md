# Cloud Functions — role assignment

Two callable functions, `setUserRole` and `removeUserRole`, are the only
things allowed to change who's Admin/Manager/Sales Manager/Accounting/Office.
They set a `role` custom claim on the target user's Firebase Auth token, and
mirror the same value into `campground/data`'s `userRoles` map (via the Admin
SDK, which bypasses `firestore.rules`) so the app's existing "Manage Access"
screen keeps displaying and behaving exactly as it does today — it just calls
these functions now instead of writing `userRoles` directly.

See `../firestore.rules` for why this matters: those two fields can no longer
be written by any client, so the app's own React code is no longer the only
thing standing between a signed-in user and granting themselves Admin.

## Deploy

```
npm install --prefix functions
firebase login
firebase deploy --only functions
firebase deploy --only firestore:rules
```

## Bootstrapping the first Admin

Nobody can call `setUserRole` as an admin until someone already has the
claim. Run `scripts/bootstrap-first-admin.js` once — see the comment at the
top of that file for the exact steps (short version: download a service
account key from the Firebase console, run the script with your email, then
delete the key).

After that, every further role change — including granting more Admins —
goes through the normal "Manage Access" screen in the app.

## Migrating existing roles

Whoever's currently assigned a role in `userRoles` today only has that as a
Firestore document field, not a claim — so once you're bootstrapped as
Admin, re-set each person's role once through "Manage Access" as normal.
That call now goes through `setUserRole`, which sets their real claim (the
document field was already correct, so nothing changes for them visually —
their access just becomes real at the database level instead of only in the
UI).
