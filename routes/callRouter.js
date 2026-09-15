const express = require("express");
const router = express.Router();
const { protect } = require("../middlewares/authMiddleware");
const { getCallHistory } = require("../controllers/callController");

router.get("/history", protect, getCallHistory);

module.exports = router;
