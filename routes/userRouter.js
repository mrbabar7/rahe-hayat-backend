const express = require("express");
const router = express.Router();
const userController = require("../controllers/accountController/userController");
const { protect } = require("../middlewares/authMiddleware");

router.get("/profile", protect, userController.getUserProfile);
router.put("/profile", protect, userController.updatePersonalInfo);
router.put("/change-password", protect, userController.changePassword);

// 2-Step Email Change
router.post(
  "/request-email-change",
  protect,
  userController.requestEmailChange,
);
router.post(
  "/resend-email-change-otp",
  protect,
  userController.resendEmailChangeOtp,
);
router.post("/verify-email-change", protect, userController.verifyEmailChange);

// Account Deletion
router.delete("/delete-account", protect, userController.deleteAccount);

module.exports = router;
