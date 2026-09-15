const mongoose = require("mongoose");

// Powers PDF screen 36 (Reviews & Ratings) — real, user-submitted testimonials
// shown on the guest home / trust section, not hardcoded marketing copy.
const reviewSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    city: { type: String, default: "" },
    role: { type: String, enum: ["donor", "seeker", "hospital"], default: "donor" },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, required: true, trim: true, maxlength: 500 },
    isPublished: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Review", reviewSchema);
