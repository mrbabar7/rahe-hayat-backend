const mongoose = require("mongoose");

// Chat is scoped 1:1 to an accepted DonationRequest (PDF screen 27 "Chat with Your
// Match") — no separate conversation/thread concept needed beyond the request itself.
const messageSchema = new mongoose.Schema(
  {
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: "DonationRequest", required: true, index: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    receiverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, default: "" },
    // BUG FIX (text messages rendering as "Location Shared" cards in
    // Chat.tsx): this is a *single nested subdocument* path. Mongoose
    // auto-vivifies a subdocument path as soon as any of its children declare
    // a `default` — here that was `isLive: { default: false }` — even when
    // the parent `location` key is never set on .create()/.save(). So every
    // plain text message was silently getting `location: { isLive: false }`
    // written to Mongo, which is a real (truthy) object with no coordinates.
    // The frontend's old `item.location ? <MapCard/> : <TextBubble/>` check
    // saw that truthy stub and rendered the location card for every message.
    // `default: undefined` on the parent path (wrapping the fields in their
    // own sub-schema) tells Mongoose not to auto-create this subdocument —
    // `location` now stays genuinely absent/undefined unless a real location
    // payload is passed in, exactly like `text` staying "" by its own default
    // instead of being invented. See chatController.js's sendMessage, which
    // only ever passes `location` when the client actually sent one.
    location: {
      type: new mongoose.Schema(
        {
          label: { type: String },
          latitude: Number,
          longitude: Number,
          // Live share (as opposed to a one-off dropped pin): isLive stays true and
          // latitude/longitude get overwritten in place as the sender's position
          // updates (see updateLiveLocation below), until expiresAt passes or the
          // sender stops it early — same "one document, updated in place" shape as
          // ambulanceModel's currentLocation, rather than a new message per tick.
          isLive: { type: Boolean, default: false },
          expiresAt: { type: Date },
        },
        { _id: false },
      ),
      default: undefined,
    },
    isRead: { type: Boolean, default: false },

    // ---- Image messages ----
    // Absolute public URL of an uploaded photo (see utils/imageUpload.js —
    // the app sends a base64 data URI in the normal JSON body, the server
    // validates its magic bytes and writes it under /public/images/chat/).
    // Same `default: undefined` discipline as `location` above: this path
    // must stay genuinely absent on a plain text message, or we'd reintroduce
    // exactly the auto-vivification bug that made every text message render
    // as a location card.
    image: {
      type: new mongoose.Schema(
        {
          url: { type: String, required: true },
          width: Number,
          height: Number,
        },
        { _id: false },
      ),
      default: undefined,
    },

    // ---- Per-message deletion (WhatsApp-style) ----
    // "Delete for me": the sender's/recipient's id is pushed here and that
    // user alone stops seeing the message. Distinct from chatDeletionModel.js,
    // which hides a whole conversation up to a timestamp — this is one
    // message at a time, and either mechanism can hide a message
    // independently of the other.
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    // "Delete for everyone": kept as a soft-delete flag rather than removing
    // the document, so both sides can render a "This message was deleted"
    // tombstone in place (matching WhatsApp) instead of having the message
    // silently vanish and leave the conversation looking edited. text/image/
    // location are cleared server-side when this is set, so the original
    // content is genuinely gone from the DB — the flag only preserves the
    // message's existence and position in the thread.
    deletedForEveryone: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);
