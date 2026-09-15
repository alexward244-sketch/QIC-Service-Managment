// One-time local script to grant the very first Admin custom claim.
//
// Only needed once, ever: after that, every future role change (including
// granting more Admins) goes through the app's own "Manage Access" screen,
// which calls the setUserRole Cloud Function — this script exists purely to
// bootstrap the first admin, since nobody can call that function as an admin
// until at least one person already has the claim.
//
// Usage:
//   1. Firebase Console → Project Settings → Service Accounts →
//      "Generate new private key". Save the downloaded file as
//      serviceAccountKey.json in this same scripts/ folder.
//      (It's covered by .gitignore — never commit it.)
//   2. cd functions/scripts && npm install firebase-admin
//   3. node bootstrap-first-admin.js you@example.com
//   4. Delete serviceAccountKey.json once you're done — it's no longer
//      needed and is a standing credential if left lying around.
//   5. Sign out of the app and back in, so your token picks up the claim.

const admin = require("firebase-admin");
const path = require("path");

const email = process.argv[2];
if (!email) {
  console.error("Usage: node bootstrap-first-admin.js you@example.com");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = require(path.join(__dirname, "serviceAccountKey.json"));
} catch (e) {
  console.error(
    "Couldn't find serviceAccountKey.json in this folder. Download one from " +
      "Firebase Console → Project Settings → Service Accounts, and save it here first."
  );
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

admin
  .auth()
  .getUserByEmail(email)
  .then((user) => admin.auth().setCustomUserClaims(user.uid, { role: "admin" }))
  .then(() => {
    console.log(`Granted the admin claim to ${email}.`);
    console.log("Ask them to sign out and back in for it to take effect.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
