const express = require("express");
const router = express.Router();
const { protect } = require("../middlewares/authMiddleware");
const { getReviews, submitReview } = require("../controllers/reviewController");

router.get("/", getReviews);
router.post("/", protect, submitReview);

module.exports = router;
