const { DonationRequest, Donor } = require("../../models/formModel");
const userModel = require("../../models/userMode");
const { createNotification } = require("../notificationController");

exports.cancelRequest = async (req, res) => {
  try {
    const { donorId } = req.params;
    const seekerId = req.user.id || req.user._id;

    const deletedRequest = await DonationRequest.findOneAndDelete({
      donorId,
      seekerId,
      status: "pending",
    });

    if (!deletedRequest) {
      return res
        .status(404)
        .json({ success: false, message: "No pending request found" });
    }

    const seeker = await userModel.findById(seekerId);
    const donor = await Donor.findById(donorId).populate("userId");

    if (donor && donor.userId) {
      await createNotification({
        userId: donor.userId._id,
        title: "Blood Request Cancelled",
        message: `${seeker ? seeker.name : "A seeker"} cancelled their blood request.`,
        link: "/(tabs)/home", // Donor dashboard is rendered by (tabs)/home based on role — see src/screens/DonorDashboard.tsx
      });
    }

    res.status(200).json({
      success: true,
      message: "Request cancelled successfully and donor notified.",
    });
  } catch (error) {
    console.error("Cancel Request Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to cancel request",
      error: error.message,
    });
  }
};

// DELETE /seeker/cancel-broadcast/:broadcastId — cancels an entire "Post a
// Request" fan-out: deletes every still-pending DonationRequest tied to it,
// marks the broadcast cancelled, and notifies any donor who already accepted
// (their individual request stays "accepted" so the chat history isn't lost —
// only pending, not-yet-responded requests are pulled back).
exports.cancelBroadcast = async (req, res) => {
  try {
    const { broadcastId } = req.params;
    const seekerId = req.user.id || req.user._id;
    const Broadcast = require("../../models/broadcastModel");

    const broadcast = await Broadcast.findOne({ _id: broadcastId, seekerId });
    if (!broadcast) {
      return res.status(404).json({ success: false, message: "Broadcast not found" });
    }

    await DonationRequest.deleteMany({ broadcastId, status: "pending" });

    const acceptedRequests = await DonationRequest.find({ broadcastId, status: "accepted" }).populate({
      path: "donorId",
      populate: { path: "userId" },
    });
    for (const r of acceptedRequests) {
      if (r.donorId?.userId?._id) {
        await createNotification({
          userId: r.donorId.userId._id,
          title: "Blood Request Cancelled",
          message: "The seeker cancelled this emergency request.",
          link: "/(tabs)/requests",
        });
      }
    }

    broadcast.status = "cancelled";
    await broadcast.save();

    res.status(200).json({ success: true, message: "Broadcast cancelled." });
  } catch (error) {
    console.error("Cancel Broadcast Error:", error);
    res.status(500).json({ success: false, message: "Failed to cancel broadcast", error: error.message });
  }
};
