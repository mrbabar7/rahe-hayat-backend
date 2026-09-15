const Call = require("../models/callModel");
const userModel = require("../models/userMode");

// GET /calls/history — powers the "Calls" tab (WhatsApp-style call log).
// Every row is one call attempt this user was either the caller or callee
// on, newest first, with the direction and "missed" state computed relative
// to *this* user (a call the callee never answered shows as "Missed" for
// them and "No answer"/outgoing for the caller — same as any phone app).
exports.getCallHistory = async (req, res) => {
  try {
    const userId = (req.user.id || req.user._id).toString();

    const calls = await Call.find({ $or: [{ callerId: userId }, { calleeId: userId }] })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const otherIds = [
      ...new Set(
        calls.map((c) => (c.callerId.toString() === userId ? c.calleeId : c.callerId).toString()),
      ),
    ];
    const users = await userModel.find({ _id: { $in: otherIds } }).select("name profilePicture");
    const byId = new Map(users.map((u) => [u._id.toString(), u]));

    const history = calls.map((c) => {
      const isOutgoing = c.callerId.toString() === userId;
      const otherUserId = (isOutgoing ? c.calleeId : c.callerId).toString();
      const other = byId.get(otherUserId);
      // "Missed", from this user's point of view, only ever applies to the
      // callee side of a call that was never answered — an outgoing call
      // nobody picked up shows as "No answer" for the caller, not "Missed".
      const missed = !isOutgoing && (c.status === "missed" || c.status === "rejected");

      return {
        _id: c._id,
        requestId: c.requestId,
        otherUserId,
        otherName: other?.name || "Unknown",
        otherProfilePicture: other?.profilePicture || "",
        direction: isOutgoing ? "outgoing" : "incoming",
        status: c.status,
        missed,
        durationSeconds: c.durationSeconds || 0,
        createdAt: c.createdAt,
      };
    });

    res.status(200).json({ success: true, calls: history });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
