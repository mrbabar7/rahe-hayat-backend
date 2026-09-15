const Review = require("../models/reviewModel");

// GET /reviews — public, feeds the guest-facing "What people are saying" section.
exports.getReviews = async (req, res) => {
  try {
    const reviews = await Review.find({ isPublished: true }).sort({ createdAt: -1 }).limit(50);
    const count = reviews.length;
    const avgRating = count > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / count : 0;
    res.status(200).json({ success: true, reviews, avgRating: Number(avgRating.toFixed(1)), count });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /reviews — authenticated, one review per user (updates their existing one on resubmit).
exports.submitReview = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { role, rating, comment, city } = req.body;

    if (!rating || !comment) {
      return res.status(400).json({ success: false, message: "Please add a rating and a comment." });
    }

    const review = await Review.findOneAndUpdate(
      { userId },
      { userId, name: req.user.name, city: city || "", role: role || "donor", rating, comment },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ success: true, review });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
