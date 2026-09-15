const Message = require("../models/messageModel");
const ChatDeletion = require("../models/chatDeletionModel");
const { DonationRequest, Donor } = require("../models/formModel");
const userModel = require("../models/userMode");
const { emitToUser, emitToRoom, sendPushNotification, isUserInChatRoom } = require("../services/socketService");
const { isDataUri, saveBase64Image, deleteStoredImage, ImageUploadError } = require("../utils/imageUpload");
const { purgeMessagesForRequests } = require("../services/chatCleanupService");

// How long after sending a message its sender may still "delete for
// everyone" (WhatsApp uses roughly this window). Past it, only "delete for
// me" remains available — enforced server-side so a patched client can't
// retroactively unsend an old message.
const DELETE_FOR_EVERYONE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Shapes a message for a specific viewer. A message deleted for everyone is
// still returned (so both sides render an in-place "This message was
// deleted" tombstone rather than the message silently vanishing), but with
// its content stripped — the content is already gone from the DB, this just
// guarantees nothing leaks even from a stale document.
const serializeMessage = (msg, viewerId) => {
  const m = msg.toObject ? msg.toObject() : msg;
  if (m.deletedForEveryone) {
    return {
      _id: m._id,
      requestId: m.requestId,
      senderId: m.senderId,
      receiverId: m.receiverId,
      deletedForEveryone: true,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }
  delete m.deletedFor;
  return m;
};

// Messages this viewer has individually deleted for themselves are removed
// from their copy of the thread entirely (no tombstone — that's the whole
// point of "delete for me").
const visibleToViewer = (msg, viewerId) =>
  !(msg.deletedFor || []).some((id) => id.toString() === viewerId.toString());

// A chat only exists for a request both sides can see, and only once it's been
// accepted (matches the PDF: numbers/chat stay locked until a request is accepted).
// Also resolves the other participant's display name (donor's fullName, falling
// back to their user account name; seeker's stored name, falling back the same
// way) — previously left for the client to guess at, which is why chat/call
// screens were showing a generic "Your match" placeholder instead of a real name.
const resolveParticipants = async (requestId, currentUserId) => {
  const request = await DonationRequest.findById(requestId)
    .populate({ path: "donorId", populate: { path: "userId", select: "name" } })
    .populate("seekerId", "name");
  if (!request) return null;

  const donorUserId = request.donorId?.userId?._id?.toString();
  const seekerUserId = request.seekerId?._id?.toString();
  const me = currentUserId.toString();

  if (me !== donorUserId && me !== seekerUserId) return null;

  const meIsSeeker = me === seekerUserId;

  return {
    request,
    otherUserId: meIsSeeker ? donorUserId : seekerUserId,
    otherName: meIsSeeker
      ? request.donorId?.fullName || request.donorId?.userId?.name || "Donor"
      : request.seekerName || request.seekerId?.name || "Seeker",
  };
};

// "Delete chat for myself" (see chatDeletionModel.js) hides everything up to
// the recorded timestamp for that user only. Returns null when nothing has
// been deleted, so callers can skip filtering entirely in the common case.
const getDeletionCutoff = async (userId, otherUserId) => {
  const rec = await ChatDeletion.findOne({ userId, otherUserId });
  return rec?.deletedAt || null;
};

exports.getMessages = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { requestId } = req.params;

    const ctx = await resolveParticipants(requestId, userId);
    if (!ctx) {
      return res.status(403).json({ success: false, message: "You are not part of this conversation." });
    }
    if (!["accepted", "completed"].includes(ctx.request.status)) {
      return res.status(403).json({ success: false, message: "Chat unlocks once this request is accepted." });
    }

    let messages = await Message.find({ requestId }).sort({ createdAt: 1 }).limit(500);

    const cutoff = await getDeletionCutoff(userId, ctx.otherUserId);
    if (cutoff) {
      messages = messages.filter((m) => m.createdAt > cutoff);
    }

    // Hide anything this user deleted just for themselves, and strip the
    // content of anything deleted for everyone.
    const payload = messages
      .filter((m) => visibleToViewer(m, userId))
      .map((m) => serializeMessage(m, userId));

    res.status(200).json({
      success: true,
      messages: payload,
      otherUserId: ctx.otherUserId,
      otherName: ctx.otherName,
      // Lets the chat screen tell "nobody's said anything yet" apart from
      // "this history was deleted" — see services/chatCleanupService.js.
      chatDeletedAt: ctx.request.chatDeletedAt,
      chatDeletedReason: ctx.request.chatDeletedReason,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { requestId } = req.params;
    const { text, location, image } = req.body;

    if (!text && !location && !image) {
      return res.status(400).json({ success: false, message: "Message can't be empty." });
    }

    const ctx = await resolveParticipants(requestId, userId);
    if (!ctx) {
      return res.status(403).json({ success: false, message: "You are not part of this conversation." });
    }
    if (!["accepted", "completed"].includes(ctx.request.status)) {
      return res.status(403).json({ success: false, message: "Chat unlocks once this request is accepted." });
    }

    // Live share (PDF "track it like real-world apps"): client sends
    // location.isLive + location.durationMinutes instead of a plain pin.
    // expiresAt is computed server-side so the client can't hand back an
    // arbitrarily long-lived share.
    let locationPayload = location || undefined;
    if (location?.isLive) {
      const durationMinutes = Math.min(Math.max(Number(location.durationMinutes) || 15, 1), 480);
      locationPayload = {
        label: location.label,
        latitude: location.latitude,
        longitude: location.longitude,
        isLive: true,
        expiresAt: new Date(Date.now() + durationMinutes * 60 * 1000),
      };
    }

    // Image messages: the app sends a base64 data URI (same pattern as
    // register-organization.tsx), which imageUpload.js validates — mime type,
    // declared size, and real magic bytes — before writing it under
    // public/images/chat/. `text` is kept alongside it as the caption, so an
    // image message with a caption is one message, not two.
    let imagePayload;
    if (image) {
      if (!isDataUri(image.dataUri || image)) {
        return res.status(400).json({ success: false, message: "Invalid image data. Please choose the photo again." });
      }
      try {
        const url = await saveBase64Image(image.dataUri || image, "chat");
        imagePayload = {
          url,
          width: Number(image.width) || undefined,
          height: Number(image.height) || undefined,
        };
      } catch (err) {
        if (err instanceof ImageUploadError) {
          return res.status(err.status || 400).json({ success: false, message: err.message });
        }
        throw err;
      }
    }

    const message = await Message.create({
      requestId,
      senderId: userId,
      receiverId: ctx.otherUserId,
      text: text || "",
      location: locationPayload,
      image: imagePayload,
    });

    emitToUser(ctx.otherUserId, "chat_message", { requestId, message });

    // Push notification for the recipient — only when they're not actively
    // sitting in this exact thread right now (isUserInChatRoom, joined by
    // app/chat/[requestId].tsx while it's mounted). That covers the app being
    // backgrounded or fully closed (its socket has dropped, same signal the
    // isOnline tracking above relies on) as well as the recipient simply being
    // on a different screen — in every one of those cases the socket emit
    // above never reaches an open chat screen, so this is the only way they'd
    // find out a message arrived. Mirrors call:invite's push-on-top-of-socket
    // pattern in socketService.js.
    if (!isUserInChatRoom(ctx.otherUserId, requestId)) {
      try {
        const recipient = await userModel
          .findById(ctx.otherUserId)
          .select("fcmToken pushToken");
        const token = recipient?.fcmToken || recipient?.pushToken;
        if (token) {
          const senderName = req.user.name || "New message";
          const body = imagePayload
            ? text
              ? `📷 ${text}`
              : "📷 Photo"
            : text
              ? text
              : "📍 Shared a location";
          await sendPushNotification(token, senderName, body, {
            link: "/chat/[requestId]",
            params: { requestId },
          });
        }
      } catch (err) {
        console.error("Error sending chat push notification:", err.message);
      }
    }

    res.status(201).json({ success: true, message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Shared by getConversations and getUserMessages: every accepted/completed
// request (as donor or seeker) that has unlocked chat, one row per request.
// A single other-user can appear in more than one row here (e.g. a repeat
// donation creates a second accepted request between the same two people).
const getRequestRows = async (userId) => {
  const asSeeker = await DonationRequest.find({
    seekerId: userId,
    status: { $in: ["accepted", "completed"] },
  }).populate({ path: "donorId", populate: { path: "userId", select: "name" } });

  const donorDoc = await Donor.findOne({ userId }).select("_id");
  const asDonor = donorDoc
    ? await DonationRequest.find({
        donorId: donorDoc._id,
        status: { $in: ["accepted", "completed"] },
      }).populate("seekerId", "name")
    : [];

  return [
    ...asSeeker.map((r) => ({
      requestId: r._id,
      otherUserId: r.donorId?.userId?._id,
      otherName: r.donorId?.fullName || r.donorId?.userId?.name || "Donor",
      status: r.status,
      updatedAt: r.updatedAt,
    })),
    ...asDonor.map((r) => ({
      requestId: r._id,
      otherUserId: r.seekerId?._id,
      otherName: r.seekerName || r.seekerId?.name || "Seeker",
      status: r.status,
      updatedAt: r.updatedAt,
    })),
  ].filter((row) => row.otherUserId);
};

// GET /chat/conversations — powers the "Chats" tab: one bar per person you've
// chatted with (as donor or seeker), with their name and last message.
// Requests are collapsed by otherUserId here — without this, a donor/seeker
// pair with more than one accepted request between them (e.g. a repeat
// donation) would otherwise show up as a separate bar per request instead of
// a single conversation.
exports.getConversations = async (req, res) => {
  try {
    const userId = (req.user.id || req.user._id).toString();

    const rows = await getRequestRows(userId);

    const byOtherUser = new Map();
    for (const row of rows) {
      const key = row.otherUserId.toString();
      if (!byOtherUser.has(key)) byOtherUser.set(key, []);
      byOtherUser.get(key).push(row);
    }

    const conversations = await Promise.all(
      Array.from(byOtherUser.entries()).map(async ([otherUserId, group]) => {
        const requestIds = group.map((r) => r.requestId);
        const cutoff = await getDeletionCutoff(userId, otherUserId);
        const messageFilter = { requestId: { $in: requestIds } };
        if (cutoff) messageFilter.createdAt = { $gt: cutoff };
        // A message this user deleted just for themselves must not keep
        // surfacing as their inbox preview.
        messageFilter.deletedFor = { $ne: userId };

        const lastMessage = await Message.findOne(messageFilter).sort({ createdAt: -1 });
        const unreadCount = await Message.countDocuments({
          ...messageFilter,
          receiverId: userId,
          isRead: false,
        });
        // The most recently updated request stands in for the group — it's
        // what the "Chats" list navigates to / sends new messages through.
        const activeRow = [...group].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )[0];

        // Deleted (for this user) with nothing new since — drop it from the
        // list entirely, same as WhatsApp's "delete chat". A message sent or
        // received afterwards (by either side) brings it right back.
        if (cutoff && !lastMessage) return null;

        return {
          requestId: activeRow.requestId,
          otherUserId,
          otherName: activeRow.otherName,
          status: activeRow.status,
          lastMessage: lastMessage?.deletedForEveryone
            ? "🚫 This message was deleted"
            : lastMessage?.image
              ? lastMessage.text
                ? `📷 ${lastMessage.text}`
                : "📷 Photo"
              : lastMessage?.text || (lastMessage?.location ? "📍 Shared a location" : ""),
          lastMessageAt: lastMessage?.createdAt || activeRow.updatedAt,
          unreadCount,
        };
      })
    );

    const visibleConversations = conversations.filter(Boolean);
    visibleConversations.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());

    res.status(200).json({ success: true, conversations: visibleConversations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /chat/user/:otherUserId/messages — full message history with one
// person, merged across every accepted/completed request you've shared with
// them. Backs the "Chats" tab bar so opening it shows the complete
// conversation instead of just whichever single request you tapped.
exports.getUserMessages = async (req, res) => {
  try {
    const userId = (req.user.id || req.user._id).toString();
    const { otherUserId } = req.params;

    const rows = await getRequestRows(userId);
    const shared = rows.filter((row) => row.otherUserId.toString() === otherUserId);

    if (shared.length === 0) {
      return res.status(403).json({ success: false, message: "You are not part of this conversation." });
    }

    const requestIds = shared.map((r) => r.requestId);
    // New messages sent from this merged view go through whichever shared
    // request was updated most recently.
    const sortedShared = [...shared].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    const activeRequestId = sortedShared[0].requestId;
    const otherName = sortedShared[0].otherName;

    let messages = await Message.find({ requestId: { $in: requestIds } })
      .sort({ createdAt: 1 })
      .limit(1000);

    const cutoff = await getDeletionCutoff(userId, otherUserId);
    if (cutoff) {
      messages = messages.filter((m) => m.createdAt > cutoff);
    }

    await Message.updateMany(
      { requestId: { $in: requestIds }, receiverId: userId, isRead: false },
      { isRead: true }
    );

    const payload = messages
      .filter((m) => visibleToViewer(m, userId))
      .map((m) => serializeMessage(m, userId));

    res.status(200).json({ success: true, messages: payload, otherUserId, otherName, requestIds, activeRequestId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /chat/:requestId/messages/:messageId/location — one tick of a live
// share (app/chat/[requestId].tsx's watchPositionAsync callback calls this
// every ~8s). Updates the same message document in place, same "one doc,
// latest position wins" shape as ambulance.js's updateAmbulanceLocation, then
// broadcasts to chat_<requestId> (see socketService.js's join_chat) so
// anyone with the thread open right now sees the pin move without a refetch.
// Deliberately no push notification per tick — only the original share and
// ordinary text messages page someone; a live pin just updates silently for
// whoever's already looking, and the DB write means anyone who opens the
// thread later still sees wherever it left off.
exports.updateLiveLocation = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { requestId, messageId } = req.params;
    const { latitude, longitude } = req.body;

    if (latitude == null || longitude == null) {
      return res.status(400).json({ success: false, message: "latitude and longitude are required." });
    }

    const ctx = await resolveParticipants(requestId, userId);
    if (!ctx) {
      return res.status(403).json({ success: false, message: "You are not part of this conversation." });
    }

    const message = await Message.findOne({ _id: messageId, requestId, senderId: userId });
    if (!message || !message.location?.isLive) {
      return res.status(404).json({ success: false, message: "No active live share found." });
    }
    if (message.location.expiresAt && message.location.expiresAt.getTime() <= Date.now()) {
      return res.status(410).json({ success: false, message: "This live share has expired." });
    }

    message.location.latitude = latitude;
    message.location.longitude = longitude;
    await message.save();

    emitToRoom(`chat_${requestId}`, "chat_location_update", {
      requestId,
      messageId: message._id,
      latitude,
      longitude,
      isLive: true,
      expiresAt: message.location.expiresAt,
    });

    res.status(200).json({ success: true, message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /chat/:requestId/messages/:messageId/stop-location — sender ends a
// live share early (the "Stop sharing" button). Auto-expiry via expiresAt
// handles the rest of the cases, so this just needs to flip isLive off and
// tell anyone watching right now.
exports.stopLiveLocation = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { requestId, messageId } = req.params;

    const message = await Message.findOne({ _id: messageId, requestId, senderId: userId });
    if (!message || !message.location?.isLive) {
      return res.status(404).json({ success: false, message: "No active live share found." });
    }

    message.location.isLive = false;
    await message.save();

    emitToRoom(`chat_${requestId}`, "chat_location_update", {
      requestId,
      messageId: message._id,
      latitude: message.location.latitude,
      longitude: message.location.longitude,
      isLive: false,
      expiresAt: message.location.expiresAt,
    });

    res.status(200).json({ success: true, message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /chat/user/:otherUserId — powers the "delete chat" feature on the
// Chats tab and inside a thread. Two modes, chosen by the client via
// `forEveryone` in the body:
//  - "for me" (default): records a ChatDeletion cutoff (see that model) so
//    everything up to now is hidden from *this* user's view only — the other
//    participant's copy of every message is untouched. A message from
//    either side afterwards makes the conversation reappear.
//  - "for everyone": hard-deletes every Message document shared between the
//    two participants across every accepted/completed request between them,
//    so it disappears for both sides for good.
exports.deleteConversation = async (req, res) => {
  try {
    const userId = (req.user.id || req.user._id).toString();
    const { otherUserId } = req.params;
    const forEveryone = !!req.body?.forEveryone;

    const rows = await getRequestRows(userId);
    const shared = rows.filter((row) => row.otherUserId.toString() === otherUserId);
    if (shared.length === 0) {
      return res.status(403).json({ success: false, message: "You are not part of this conversation." });
    }

    const requestIds = shared.map((r) => r.requestId);

    if (forEveryone) {
      // Also unlinks any uploaded chat photos from disk — see
      // services/chatCleanupService.js. Without this, a hard-deleted
      // conversation's photos would silently survive as orphaned files with
      // nothing left in the DB pointing to them.
      await purgeMessagesForRequests(requestIds);
      // Also clear any lingering "deleted for me" cutoffs on both sides —
      // nothing is left for either of them to hide anymore.
      await ChatDeletion.deleteMany({
        $or: [
          { userId, otherUserId },
          { userId: otherUserId, otherUserId: userId },
        ],
      });
      emitToUser(otherUserId, "chat_deleted", { otherUserId: userId, forEveryone: true });
    } else {
      await ChatDeletion.findOneAndUpdate(
        { userId, otherUserId },
        { deletedAt: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /chat/:requestId/messages/:messageId
// Body: { forEveryone?: boolean }
//
// "For me" marks the message hidden for the caller only — either participant
// may do this, at any time, to any message.
// "For everyone" is restricted to the sender, and only within
// DELETE_FOR_EVERYONE_WINDOW_MS. The content is genuinely erased from the DB
// (text/image/location cleared, the image file unlinked from disk); the
// document survives only to carry the "deleted" tombstone both clients render
// in place.
exports.deleteMessage = async (req, res) => {
  try {
    const userId = (req.user.id || req.user._id).toString();
    const { requestId, messageId } = req.params;
    const forEveryone = !!req.body?.forEveryone;

    const ctx = await resolveParticipants(requestId, userId);
    if (!ctx) {
      return res.status(403).json({ success: false, message: "You are not part of this conversation." });
    }

    const message = await Message.findOne({ _id: messageId, requestId });
    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found." });
    }

    if (!forEveryone) {
      if (!message.deletedFor.some((id) => id.toString() === userId)) {
        message.deletedFor.push(userId);
        await message.save();
      }
      return res.status(200).json({ success: true, forEveryone: false, messageId });
    }

    // --- delete for everyone ---
    if (message.senderId.toString() !== userId) {
      return res.status(403).json({ success: false, message: "You can only delete your own messages for everyone." });
    }
    if (message.deletedForEveryone) {
      return res.status(200).json({ success: true, forEveryone: true, messageId });
    }
    if (Date.now() - new Date(message.createdAt).getTime() > DELETE_FOR_EVERYONE_WINDOW_MS) {
      return res.status(400).json({
        success: false,
        message: "This message is too old to delete for everyone. You can still delete it for yourself.",
      });
    }

    // Free the disk file before clearing the reference to it, or the path is
    // lost and the upload is orphaned in public/images/chat/ forever.
    if (message.image?.url) {
      try {
        await deleteStoredImage(message.image.url);
      } catch (err) {
        console.error("Error removing chat image from disk:", err.message);
      }
    }

    message.text = "";
    message.image = undefined;
    message.location = undefined;
    message.deletedForEveryone = true;
    message.deletedAt = new Date();
    await message.save();

    // Live update on the other device, so the tombstone appears immediately
    // rather than on their next refresh.
    emitToUser(ctx.otherUserId, "chat_message_deleted", { requestId, messageId, forEveryone: true });

    res.status(200).json({ success: true, forEveryone: true, messageId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /chat/:requestId/mark-read — call when opening a thread so the Chats
// tab's unread badge clears.
exports.markThreadRead = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { requestId } = req.params;
    await Message.updateMany({ requestId, receiverId: userId, isRead: false }, { isRead: true });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
