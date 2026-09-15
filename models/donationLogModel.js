const mongoose = require("mongoose");

// One row per completed donation, so the leaderboard can group by real calendar
// month instead of ranking by the Donor's cumulative all-time livesSaved total.
const donationLogSchema = new mongoose.Schema(
  {
    donorId: { type: mongoose.Schema.Types.ObjectId, ref: "Donor", required: true },
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: "DonationRequest", required: true },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DonationLog", donationLogSchema);
