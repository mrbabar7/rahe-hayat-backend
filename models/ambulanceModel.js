const mongoose = require("mongoose");

const AmbulanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    formType: { type: String, default: "ambulance" },
    name: { type: String, required: true, trim: true },
    orgType: { type: String, required: true },
    timing: { type: String, required: true }, // e.g., "09:00 AM - 05:00 PM"
    startTime: { type: Date, required: true }, // ISO Date object from picker
    endTime: { type: Date, required: true }, // ISO Date object from picker
    phone: { type: String, required: true },
    whatsapp: { type: String, required: true },
    category: { type: [String], required: true },
    operatingDays: { type: [String], required: true },
    website: { type: String, default: "" },
    address: { type: String, required: true },
    // Live tracking (PDF screen 34) — set by the registering user via the app's
    // "Go live" toggle while driving; consumed by anyone tracking that dispatch.
    trackingStatus: { type: String, enum: ["idle", "en_route", "arrived"], default: "idle" },
    currentLocation: {
      latitude: { type: Number },
      longitude: { type: Number },
      updatedAt: { type: Date },
    },
    // Base64 data-URI image uploaded from the registration form (no S3/multer setup in this project, so store inline).
    image: { type: String, default: "" },
    isVerified: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Ambulance", AmbulanceSchema);
