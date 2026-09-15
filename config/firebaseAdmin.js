// const admin = require("firebase-admin");
// const path = require("path");
// const serviceAccount = require(
//   path.join(__dirname, "../serviceAccountKey.json"),
// );
// const cert =
//   admin.credential?.cert ||
//   admin.default?.credential?.cert ||
//   require("firebase-admin/app").cert;
// const initializeApp =
//   admin.initializeApp ||
//   admin.default?.initializeApp ||
//   require("firebase-admin/app").initializeApp;
// const getApps =
//   admin.getApps ||
//   admin.default?.getApps ||
//   require("firebase-admin/app").getApps;
// const apps = getApps ? getApps() : admin.apps || [];
// if (apps.length === 0) {
//   initializeApp({
//     credential: cert(serviceAccount),
//   });
// }
// module.exports = admin.default || admin;

// const { initializeApp, cert, getApps } = require("firebase-admin/app");
// const { getMessaging } = require("firebase-admin/messaging");
// const path = require("path");

// let serviceAccount;

// // 1. Load credentials from Railway Environment Variable
// if (process.env.FIREBASE_SERVICE_ACCOUNT) {
//   try {
//     serviceAccount =
//       typeof process.env.FIREBASE_SERVICE_ACCOUNT === "string"
//         ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
//         : process.env.FIREBASE_SERVICE_ACCOUNT;
//   } catch (err) {
//     console.error(
//       "❌ Failed to parse FIREBASE_SERVICE_ACCOUNT env var:",
//       err.message,
//     );
//   }
// }

// // 2. Fallback to local JSON file if env var is missing
// if (!serviceAccount) {
//   try {
//     serviceAccount = require(path.join(__dirname, "../serviceAccountKey.json"));
//   } catch (err) {
//     console.error("❌ Could not load serviceAccountKey.json:", err.message);
//   }
// }

// // 3. Fix escaped private_key newlines (\n -> actual newlines)
// if (serviceAccount && serviceAccount.private_key) {
//   serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
// }

// // 4. Initialize Firebase Admin
// if (getApps().length === 0) {
//   if (serviceAccount && serviceAccount.project_id) {
//     initializeApp({
//       credential: cert(serviceAccount),
//     });
//     console.log("🔥 Firebase Admin SDK initialized successfully.");
//   } else {
//     console.error("⚠️ Firebase Admin missing valid credentials!");
//   }
// }

// const messaging = getMessaging();

// module.exports = {
//   messaging,
// };

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

let serviceAccount;

// 1. Load from Base64 env variable (Local .env or Railway)
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  try {
    const decodedJson = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      "base64",
    ).toString("utf8");
    serviceAccount = JSON.parse(decodedJson);
  } catch (err) {
    console.error("❌ Failed to parse Base64 Firebase config:", err.message);
  }
}

// 2. Fallback to raw JSON string env variable
if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount =
      typeof process.env.FIREBASE_SERVICE_ACCOUNT === "string"
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : process.env.FIREBASE_SERVICE_ACCOUNT;
  } catch (err) {
    console.error("❌ Failed to parse JSON Firebase config:", err.message);
  }
}

// 3. Fix private key newlines if necessary
if (serviceAccount && serviceAccount.private_key) {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}

// 4. Initialize Firebase Admin
if (getApps().length === 0) {
  if (serviceAccount && serviceAccount.project_id) {
    initializeApp({
      credential: cert(serviceAccount),
    });
    console.log("🔥 Firebase Admin SDK initialized successfully.");
  } else {
    console.error("⚠️ Firebase Admin missing valid credentials!");
  }
}

// getMessaging() throws synchronously if no app was initialized above (e.g.
// missing/invalid credentials) — and since this whole file runs at
// `require()` time from server.js, that throw previously took down the
// entire server on boot, not just push notifications. Every caller
// (services/socketService.js) already wraps messaging.send() in try/catch
// expecting it to fail sometimes, so a safe stub here lets those existing
// catch blocks do their job instead of the process crashing before it
// starts.
let messaging;
if (getApps().length > 0) {
  messaging = getMessaging();
} else {
  messaging = {
    send: async () => {
      throw new Error(
        "Firebase Admin not initialized — push notification skipped.",
      );
    },
  };
}

module.exports = { messaging };
