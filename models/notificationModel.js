const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  message: { type: String, required: true },
  link: { type: String, default: "" }, // Web fallback link
  data: { type: Object, default: {} }, // Mobile navigation payload { screen: 'RequestDetails', params: { requestId: '123' } }
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Notification", notificationSchema);
