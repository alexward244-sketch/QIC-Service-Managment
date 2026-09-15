const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

const VALID_ROLES = ["admin", "manager", "salesmanager", "accounting", "office"];
const ROLES_DOC = admin.firestore().doc("campground/data");

function requireCallerIsAdmin(request) {
  const callerRole = request.auth && request.auth.token && request.auth.token.role;
  if (!request.auth || callerRole !== "admin") {
    throw new HttpsError("permission-denied", "Only an Admin can change roles.");
  }
}

// Counts how many *other* users currently hold the admin claim, so a caller
// can't demote or remove the last admin and lock everyone out — mirrors the
// app's own existing safety net (getUserRole treats "no admin assigned yet"
// as "everyone is admin") from the other direction.
async function otherAdminCount(excludeUid) {
  const { users } = await admin.auth().listUsers(1000);
  return users.filter((u) => u.uid !== excludeUid && u.customClaims && u.customClaims.role === "admin").length;
}

exports.setUserRole = onCall(async (request) => {
  requireCallerIsAdmin(request);

  const email = ((request.data && request.data.email) || "").trim().toLowerCase();
  const role = request.data && request.data.role;
  if (!email) throw new HttpsError("invalid-argument", "Missing email.");
  if (!VALID_ROLES.includes(role)) {
    throw new HttpsError("invalid-argument", `Role must be one of: ${VALID_ROLES.join(", ")}`);
  }

  const user = await admin.auth().getUserByEmail(email).catch(() => null);
  if (!user) {
    throw new HttpsError(
      "not-found",
      `No account found for ${email}. They need to sign in at least once before their role can be set.`
    );
  }

  const wasAdmin = user.customClaims && user.customClaims.role === "admin";
  if (wasAdmin && role !== "admin") {
    const remaining = await otherAdminCount(user.uid);
    if (remaining === 0) {
      throw new HttpsError("failed-precondition", `${email} is the last Admin — assign another Admin first.`);
    }
  }

  await admin.auth().setCustomUserClaims(user.uid, { role });
  // Mirror into the shared document so the existing "Manage Access" list (and
  // any other UI reading db.userRoles) keeps working unchanged. This write
  // uses the Admin SDK, which bypasses firestore.rules entirely — it's the
  // one trusted path allowed to touch this field; see firestore.rules.
  await ROLES_DOC.update({ [`userRoles.${email}`]: role });

  return { ok: true, email, role };
});

exports.removeUserRole = onCall(async (request) => {
  requireCallerIsAdmin(request);

  const email = ((request.data && request.data.email) || "").trim().toLowerCase();
  if (!email) throw new HttpsError("invalid-argument", "Missing email.");

  const user = await admin.auth().getUserByEmail(email).catch(() => null);
  if (user) {
    const wasAdmin = user.customClaims && user.customClaims.role === "admin";
    if (wasAdmin) {
      const remaining = await otherAdminCount(user.uid);
      if (remaining === 0) {
        throw new HttpsError("failed-precondition", `${email} is the last Admin — assign another Admin first.`);
      }
    }
    await admin.auth().setCustomUserClaims(user.uid, { role: null });
  }
  await ROLES_DOC.update({ [`userRoles.${email}`]: admin.firestore.FieldValue.delete() });

  return { ok: true };
});
