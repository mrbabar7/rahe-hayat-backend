const Broadcast = require("../../models/broadcastModel");
const { DonationRequest } = require("../../models/formModel");

// GET /seeker/my-broadcasts — feeds the "My Requests" list on PDF screen 15
// alongside the existing direct-request list from getMyRequests.
exports.getMyBroadcasts = async (req, res) => {
  try {
    const seekerId = req.user.id || req.user._id;
    const broadcasts = await Broadcast.find({ seekerId }).sort({ createdAt: -1 }).limit(50);

    const withCounts = await Promise.all(
      broadcasts.map(async (b) => {
        const requests = await DonationRequest.find({ broadcastId: b._id });
        return {
          ...b.toObject(),
          matchedCount: requests.filter((r) => r.status === "accepted").length,
          completedCount: requests.filter((r) => r.status === "completed").length,
          // Added so the app can tell a broadcast that's still waiting on
          // replies apart from one where every donor has already answered
          // (all rejected, none accepted/completed) — without these the
          // client can't distinguish "still searching" from "nobody could
          // help" and was sending seekers back into the live SOS screen
          // for both.
          pendingCount: requests.filter((r) => r.status === "pending").length,
          rejectedCount: requests.filter((r) => r.status === "rejected").length,
        };
      })
    );

    res.status(200).json({ success: true, broadcasts: withCounts });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load your requests", error: error.message });
  }
};
