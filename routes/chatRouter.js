const express = require("express");
const router = express.Router();
const { protect } = require("../middlewares/authMiddleware");
const {
  getMessages,
  sendMessage,
  getConversations,
  markThreadRead,
  getUserMessages,
  updateLiveLocation,
  stopLiveLocation,
  deleteConversation,
  deleteMessage,
} = require("../controllers/chatController");

router.get("/conversations", protect, getConversations);
router.get("/user/:otherUserId/messages", protect, getUserMessages);
router.delete("/user/:otherUserId", protect, deleteConversation);
router.get("/:requestId/messages", protect, getMessages);
router.post("/:requestId/messages", protect, sendMessage);
router.post("/:requestId/mark-read", protect, markThreadRead);
router.patch("/:requestId/messages/:messageId/location", protect, updateLiveLocation);
router.post("/:requestId/messages/:messageId/stop-location", protect, stopLiveLocation);
// Per-message delete (body: { forEveryone?: boolean }) — see deleteMessage.
router.delete("/:requestId/messages/:messageId", protect, deleteMessage);

module.exports = router;
