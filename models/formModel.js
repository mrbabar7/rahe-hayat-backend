// models/donorModel.js
const mongoose = require("mongoose");

const donorSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    fullName: { type: String, required: true },
    age: { type: Number, required: true },
    gender: { type: String, required: true },
    bloodType: { type: String, required: true },
    mobileNumber: { type: String, required: true },
    province: { type: String, required: true },
    district: { type: String, required: true },
    // Real device GPS captured at registration (optional — powers real distance
    // search instead of a slider that does nothing). Not required so existing
    // donors without it keep working exactly as before.
    location: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
    profilePicture: { type: String, default: "" },
    isAvailable: { type: Boolean, default: true },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    livesSaved: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 },
    lastDonationDate: { type: Date, default: null },
    nextAvailableDate: { type: Date, default: null },
    // Admin account controls (Donor Detail screen). All additive/defaulted so
    // every existing donor document keeps working unchanged.
    isSuspended: { type: Boolean, default: false },
    isFlagged: { type: Boolean, default: false },
    flagReason: { type: String, default: "" },
    appearsInPublicSearch: { type: Boolean, default: true },
    pushNotificationsEnabled: { type: Boolean, default: true },
    referralCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const requestSchema = new mongoose.Schema(
  {
    seekerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    donorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Donor",
      required: true,
    },
    // Set when this request was created as part of a "Post a Request" / Emergency
    // Broadcast fan-out (PDF screens 14-17), so the seeker can track all responses
    // to one broadcast together. Left null for direct one-donor requests.
    broadcastId: { type: mongoose.Schema.Types.ObjectId, ref: "Broadcast", default: null },
    requestedBloodType: { type: String, required: true },
    seekerName: { type: String, required: true },
    seekerPhone: { type: String, required: true },
    seekerLocation: {
      province: { type: String, required: true },
      city: { type: String, required: true },
      addressLine: { type: String, required: true },
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "completed"],
      default: "pending",
    },
    isRated: { type: Boolean, default: false }, // Tracks if seeker gave rating for this donation
    rating: { type: Number, default: 0 }, // Rating score given for this request
    completedAt: { type: Date, default: null },
    expireAt: { type: Date, default: null },

    // ---- Donor-confirms-donation -> seeker-confirms-received flow ----
    // Set the moment the donor taps "I've Donated Blood" on an accepted
    // request (donorController/markDonated.js). Deliberately does NOT change
    // `status` — status stays "accepted" until the seeker actually confirms
    // via completeDonation.js, so every existing status-based check
    // elsewhere in the app (chat access, admin dashboards, history filters)
    // keeps working unchanged. This is purely a second timestamp layered on
    // top of the existing state machine, and is what
    // services/chatCleanupCron.js uses to compute the 3-day countdown.
    donorMarkedDonatedAt: { type: Date, default: null },
    // Set once the "confirm within 3 days or the chat gets deleted" reminder
    // has actually been sent, so the cron never sends it twice.
    chatDeleteWarningSentAt: { type: Date, default: null },
    // Set the moment this request's chat is actually purged — either
    // immediately on a successful completeDonation, or by the 3-day cron.
    // Lets both the API and the app tell "this chat was deleted, here's why"
    // apart from "this chat was simply never started".
    chatDeletedAt: { type: Date, default: null },
    chatDeletedReason: {
      type: String,
      enum: [null, "completed", "unconfirmed_timeout"],
      default: null,
    },
  },
  { timestamps: true },
);

// or keep TTL index if auto-deletion on expireAt is desired.
requestSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const Donor = mongoose.model("Donor", donorSchema);
const DonationRequest = mongoose.model("DonationRequest", requestSchema);

module.exports = { Donor, DonationRequest };
