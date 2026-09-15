const { Server } = require("socket.io");
const { messaging } = require("../config/firebaseAdmin");

let io;

const getUserModel = () => {
  try {
    return require("../models/userMode");
  } catch (e) {
    return require("../models/userMode");
  }
};

const getDonorModel = () => {
  try {
    const donorModule = require("../models/formModel");
    return donorModule.Donor || donorModule;
  } catch (e) {
    return null;
  }
};

const setUserOnlineStatus = async (userId, isOnline) => {
  if (!userId) return;
  const now = new Date();

  try {
    const User = getUserModel();
    const Donor = getDonorModel();

    const updates = [
      User.findByIdAndUpdate(userId, { isOnline, lastSeen: now }),
    ];

    if (Donor) {
      updates.push(
        Donor.findOneAndUpdate({ userId: userId }, { isOnline, lastSeen: now }),
      );
    }

    await Promise.all(updates);

    if (io) {
      io.emit("donor_status_changed", {
        userId: userId.toString(),
        isOnline,
        lastSeen: now,
      });
    }
  } catch (err) {
    console.error(`Error updating status for user ${userId}:`, err.message);
  }
};

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PUT", "DELETE"],
    },
  });

  io.on("connection", (socket) => {
    console.log("⚡ New Client Connected:", socket.id);

    const handleUserConnect = async (userId) => {
      if (!userId) return;
      const userRoom = userId.toString();
      socket.join(userRoom);
      socket.userId = userRoom;
      await setUserOnlineStatus(userId, true);
    };

    socket.on("join_room", handleUserConnect);
    socket.on("register_user", handleUserConnect);

    // Anyone tracking a dispatch (PDF screen 34) joins this room to receive live
    // position updates — no auth required to watch, matching a public "track" link.
    socket.on("join_ambulance_room", (ambulanceId) => {
      if (ambulanceId) socket.join(`ambulance_${ambulanceId}`);
    });
    socket.on("leave_ambulance_room", (ambulanceId) => {
      if (ambulanceId) socket.leave(`ambulance_${ambulanceId}`);
    });

    // A user currently looking at a given chat thread (app/chat/[requestId].tsx)
    // joins this room for as long as that screen is mounted. chatController's
    // sendMessage checks isUserInChatRoom() before sending a push for a new
    // message — so someone actively reading the thread doesn't also get an OS
    // notification for it, while a backgrounded/closed app (whose socket has
    // dropped, same as the isOnline tracking above) or a different screen still
    // does. Same join/leave-room shape as join_ambulance_room above.
    socket.on("join_chat", (requestId) => {
      if (requestId) socket.join(`chat_${requestId}`);
    });
    socket.on("leave_chat", (requestId) => {
      if (requestId) socket.leave(`chat_${requestId}`);
    });

    // ---- In-app call signaling relay (PDF screen 28) ----
    // Pure relay: forwards whatever payload the caller sends to the other
    // participant's room. Enough to ring/notify and to carry WebRTC
    // offer/answer/ICE payloads once a WebRTC layer is wired in on the client.
    //
    // REQUIREMENT 3.2 also asks this layer to keep an accurate call history
    // across both devices — every call:invite below creates a Call
    // document (models/callModel.js) that call:accept / call:reject /
    // call:end / the safety-net timeout further down then update in place.
    // getCallHistory (controllers/callController.js) is what the Calls tab
    // reads back out. This bookkeeping is deliberately best-effort: it never
    // throws into the socket handler and never blocks the relay/push above
    // it, so a DB hiccup degrades to "history entry missing", not "the call
    // itself breaks".
    socket.on("call:invite", async ({ toUserId, requestId, fromName }) => {
      emitToUser(toUserId, "call:invite", { requestId, fromName, fromUserId: socket.userId });

      try {
        const Call = require("../models/callModel");
        await Call.create({
          requestId,
          callerId: socket.userId,
          calleeId: toUserId,
          status: "ringing",
        });
      } catch (err) {
        console.error("Error creating call history entry:", err.message);
      }

      // Safety-net "missed" timer: mirrors the client's own ~45s no-answer
      // timeout (see app/call/[requestId].tsx's armNoAnswerTimeout and
      // SocketContext.tsx's ring-timeout for the foreground overlay), so a
      // call still gets correctly marked "missed" in history even if the
      // caller's app is killed/loses connectivity before it can emit
      // call:end itself. Sits a few seconds behind the client timeouts on
      // purpose, so it only ever fires as a backstop, never races them.
      setTimeout(async () => {
        try {
          const Call = require("../models/callModel");
          const call = await Call.findOne({
            requestId,
            callerId: socket.userId,
            calleeId: toUserId,
            status: "ringing",
          }).sort({ createdAt: -1 });
          if (!call) return;
          call.status = "missed";
          call.endedAt = new Date();
          await call.save();
          emitToUser(toUserId, "call:missed", { requestId, fromUserId: socket.userId });
          emitToUser(socket.userId, "call:missed", { requestId, toUserId });
        } catch (err) {
          console.error("Error finalizing missed call:", err.message);
        }
      }, 50000);

      // The emit above only reaches an already-connected socket — if the
      // callee's app is backgrounded or closed, that ring goes nowhere and
      // they never even see the incoming call. Send a push too, so it still
      // shows up either way: a VoIP push (wakes the app even from fully
      // killed, see sendVoipPushNotification) if they're on iOS and have
      // registered one, otherwise the regular push everything else in this
      // app already uses. Tapping the regular one deep-links straight into
      // this screen as the callee (SocketContext.tsx's navigateFromPush); the
      // VoIP one displays a native incoming-call screen directly via CallKeep.
      try {
        const User = getUserModel();
        const callee = await User.findById(toUserId).select("fcmToken pushToken voipPushToken");
        if (callee?.voipPushToken) {
          await sendVoipPushNotification(callee.voipPushToken, {
            requestId,
            fromName: fromName || "",
            fromUserId: socket.userId,
          });
        } else {
          const token = callee?.fcmToken || callee?.pushToken;
          if (token) {
            await sendPushNotification(
              token,
              fromName ? `${fromName} is calling…` : "Incoming call",
              "Tap to answer",
              { link: "/call/[requestId]", params: { requestId, toUserId: socket.userId, toUserName: fromName || "" } }
            );
          }
        }
      } catch (err) {
        console.error("Error sending call push notification:", err.message);
      }
    });
    // Callee -> server, once they tap "Accept" (native CallKit answer or the
    // in-app IncomingCallOverlay — see SocketContext.tsx). Marks the call
    // history entry answered; forwarded to the caller as its own event
    // (REQUIREMENT 3.2) — the caller's call screen doesn't need to listen
    // for it (it already detects "connected" from the WebRTC track itself),
    // but it's there for anything that wants to react to it, e.g. a future
    // "ringing… answered" status.
    socket.on("call:accept", async ({ toUserId, requestId }) => {
      emitToUser(toUserId, "call:accept", { requestId, fromUserId: socket.userId });
      try {
        const Call = require("../models/callModel");
        const call = await Call.findOne({
          requestId,
          calleeId: socket.userId,
          callerId: toUserId,
          status: "ringing",
        }).sort({ createdAt: -1 });
        if (!call) return;
        call.status = "accepted";
        call.answeredAt = new Date();
        await call.save();
      } catch (err) {
        console.error("Error recording call:accept:", err.message);
      }
    });
    // Callee -> server, once they tap "Decline". Relayed to the caller as
    // call:end — the exact same event/effect a decline has always had on the
    // caller's screen (stops ringing immediately, dismisses any native
    // CallKit UI) — while also recording an explicit "rejected" in call
    // history, distinct from a plain no-answer timeout (REQUIREMENT 3.2).
    socket.on("call:reject", async ({ toUserId, requestId }) => {
      emitToUser(toUserId, "call:end", { requestId, fromUserId: socket.userId });
      try {
        const Call = require("../models/callModel");
        const call = await Call.findOne({
          requestId,
          calleeId: socket.userId,
          callerId: toUserId,
          status: "ringing",
        }).sort({ createdAt: -1 });
        if (!call) return;
        call.status = "rejected";
        call.endedAt = new Date();
        await call.save();
      } catch (err) {
        console.error("Error recording call:reject:", err.message);
      }
    });
    // Callee -> caller: "my call screen has mounted and is listening for an
    // offer now". The caller waits for this before creating/sending its SDP
    // offer, so the offer is never emitted into a screen that isn't open yet
    // to receive it (which was silently dropping the call before).
    socket.on("call:ready", ({ toUserId, requestId }) => {
      emitToUser(toUserId, "call:ready", { requestId, fromUserId: socket.userId });
    });
    socket.on("call:offer", ({ toUserId, requestId, sdp }) => {
      emitToUser(toUserId, "call:offer", { requestId, sdp, fromUserId: socket.userId });
    });
    socket.on("call:answer", ({ toUserId, requestId, sdp }) => {
      emitToUser(toUserId, "call:answer", { requestId, sdp, fromUserId: socket.userId });
    });
    socket.on("call:ice-candidate", ({ toUserId, requestId, candidate }) => {
      emitToUser(toUserId, "call:ice-candidate", { requestId, candidate, fromUserId: socket.userId });
    });
    socket.on("call:end", async ({ toUserId, requestId }) => {
      emitToUser(toUserId, "call:end", { requestId, fromUserId: socket.userId });
      // REQUIREMENT 3.2: finalize this call's history entry. A call that was
      // already "accepted" becomes "completed" with a real duration; one
      // still sitting at "ringing" (the caller gave up / hung up before the
      // callee ever answered) becomes "missed" — same as a real phone's call
      // log entry for an unanswered outgoing call.
      try {
        const Call = require("../models/callModel");
        const call = await Call.findOne({
          requestId,
          status: { $in: ["ringing", "accepted"] },
        }).sort({ createdAt: -1 });
        if (!call) return;
        const now = new Date();
        if (call.status === "accepted") {
          call.status = "completed";
          call.endedAt = now;
          call.durationSeconds = call.answeredAt
            ? Math.max(0, Math.round((now.getTime() - call.answeredAt.getTime()) / 1000))
            : 0;
        } else {
          call.status = "missed";
          call.endedAt = now;
        }
        await call.save();
      } catch (err) {
        console.error("Error finalizing call on call:end:", err.message);
      }
    });
    // Callee -> caller: "I'm already on another call". Lets the caller find
    // out immediately instead of ringing uselessly for the full no-answer
    // window — matters more here than in a typical chat app, since this is
    // blood-donation/emergency calling and the caller may need to move on to
    // another donor right away.
    socket.on("call:busy", async ({ toUserId, requestId }) => {
      emitToUser(toUserId, "call:busy", { requestId, fromUserId: socket.userId });
      // Neither side emits call:end for a busy response (the caller's call
      // screen just backs out locally — see app/call/[requestId].tsx's
      // onBusy), so without this the history entry would sit at "ringing"
      // until the 50s safety-net timeout mislabels it "missed" instead of
      // "busy".
      try {
        const Call = require("../models/callModel");
        const call = await Call.findOne({
          requestId,
          calleeId: socket.userId,
          callerId: toUserId,
          status: "ringing",
        }).sort({ createdAt: -1 });
        if (!call) return;
        call.status = "busy";
        call.endedAt = new Date();
        await call.save();
      } catch (err) {
        console.error("Error recording call:busy:", err.message);
      }
    });

    socket.on("disconnect", async () => {
      const userId = socket.userId;
      if (userId) {
        const roomSockets = io.sockets.adapter.rooms.get(userId);
        if (!roomSockets || roomSockets.size === 0) {
          await setUserOnlineStatus(userId, false);
        }
      }
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    console.warn("⚠️ Warning: getIO() called before socket initialization!");
  }
  return io;
};

const emitToUser = (userId, event, payload) => {
  if (io && userId) {
    io.to(userId.toString()).emit(event, payload);
  }
};

// Generic room emit — used for ambulance live-tracking (PDF screen 34), where many
// anonymous trackers (not just one userId) need the same location broadcast.
const emitToRoom = (room, event, payload) => {
  if (io && room) {
    io.to(room).emit(event, payload);
  }
};

// True if `userId` has a live socket currently sitting in chat_<requestId>
// (see join_chat/leave_chat above) — i.e. they're actively looking at that
// thread right now, not just online somewhere else in the app.
const isUserInChatRoom = (userId, requestId) => {
  if (!io || !userId || !requestId) return false;
  const room = io.sockets.adapter.rooms.get(`chat_${requestId}`);
  if (!room) return false;
  for (const socketId of room) {
    if (io.sockets.sockets.get(socketId)?.userId === userId.toString()) {
      return true;
    }
  }
  return false;
};

/**
 * Sends a real-time push notification using Firebase Cloud Messaging (FCM)
 */
const sendPushNotification = async (fcmToken, title, body, data = {}) => {
  if (!fcmToken) {
    console.log("[Push Notification Skipped] Missing FCM Token");
    return;
  }

  // FCM data values MUST strictly be strings
  const formattedData = {};
  for (const key in data) {
    if (data[key] !== undefined && data[key] !== null) {
      formattedData[key] =
        typeof data[key] === "object"
          ? JSON.stringify(data[key])
          : String(data[key]);
    }
  }

  const pushTitle = title || "Blood Donation Alert";
  const pushBody = body || "";

  const messagePayload = {
    token: fcmToken,
    notification: {
      title: pushTitle,
      body: pushBody,
    },
    data: formattedData,
    android: {
      priority: "high", // Delivers immediately across lock/doze states
      notification: {
        title: pushTitle,
        body: pushBody,
        sound: "default",
        channelId: "high_importance_v1", // High priority channel for drop-down banner
        priority: "max", // Enables Android heads-up drop-down banner
        visibility: "public", // Displays on locked screen
        defaultVibrateTimings: true,
        defaultLightSettings: true,
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          contentAvailable: true,
        },
      },
    },
  };

  try {
    const response = await messaging.send(messagePayload);
    console.log("🔥 FCM Push Notification Sent Successfully:", response);
    return response;
  } catch (error) {
    console.error(
      "❌ Error sending FCM push notification:",
      error.message || error,
    );
  }
};

const notifyUser = async ({
  userId,
  fcmToken,
  title,
  body,
  data,
  socketEvent,
  socketPayload,
}) => {
  if (socketEvent) {
    emitToUser(userId, socketEvent, socketPayload);
  }
  if (fcmToken) {
    await sendPushNotification(fcmToken, title, body, data);
  }
};

// A regular push (sendPushNotification above) is what's used everywhere else
// in this app, and it works for calls too *while iOS still has some process
// time left* (backgrounded but not yet suspended/killed). It does NOT reliably
// wake an iOS app that's already been killed — which is exactly when an
// incoming call notification matters most. PushKit VoIP pushes are Apple's
// mechanism for that specific case: the OS wakes the app for a VoIP push even
// from fully killed, no matter what, provided the payload is actually used to
// report a call via CallKit (Apple can throttle/revoke VoIP push privileges
// for an app that accepts VoIP pushes without displaying a CallKit call, so
// the client-side CallKeep wiring in src/services/callKeepService.ts must
// stay in lock-step with this).
//
// IMPORTANT — this depends on the Firebase project's APNs credentials being a
// token-based .p8 Auth Key (Firebase Console → Project Settings → Cloud
// Messaging → Apple app configuration). A .p8 key can send to any APNs topic
// for the app, including the required "<bundleId>.voip" VoIP topic used below.
// A legacy .p12 certificate is typically scoped to standard push only and
// won't deliver this. This is the one piece of this integration that cannot
// be verified without an actual VoIP-registered iOS build on a real device —
// confirm it end-to-end there before relying on it.
const sendVoipPushNotification = async (voipToken, data = {}) => {
  if (!voipToken) return;

  const formattedData = {};
  for (const key of Object.keys(data)) {
    if (data[key] !== undefined && data[key] !== null) {
      formattedData[key] =
        typeof data[key] === "object" ? JSON.stringify(data[key]) : String(data[key]);
    }
  }

  const bundleId = process.env.IOS_BUNDLE_ID || "com.blooddonation.app";

  try {
    const response = await messaging.send({
      token: voipToken,
      data: formattedData,
      apns: {
        headers: {
          "apns-push-type": "voip",
          "apns-topic": `${bundleId}.voip`,
          "apns-priority": "10",
          "apns-expiration": "0",
        },
        payload: {
          aps: {
            // VoIP payloads carry no visible "notification" of their own —
            // the app is woken silently and is responsible for calling
            // RNCallKeep.displayIncomingCall itself (see callKeepService.ts),
            // which is what actually produces the native ringing UI.
            "content-available": 1,
          },
        },
      },
    });
    console.log("📞 VoIP push sent:", response);
    return response;
  } catch (error) {
    console.error("❌ Error sending VoIP push notification:", error.message || error);
  }
};

module.exports = {
  initSocket,
  getIO,
  emitToUser,
  emitToRoom,
  isUserInChatRoom,
  sendPushNotification,
  sendVoipPushNotification,
  notifyUser,
};
