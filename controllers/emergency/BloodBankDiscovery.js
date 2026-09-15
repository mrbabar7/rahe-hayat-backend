const BloodBank = require("../../models/bankModel");

// Public directory — must only show admin-verified listings. This used to
// return everything (find() with no filter), so a freshly-submitted,
// unreviewed org was visible to seekers immediately, ahead of the 24-48h
// verification the app promises and ahead of the admin verification queue
// ever seeing it.
const getBloodBanks = async (req, res) => {
  try {
    const banks = await BloodBank.find({ isVerified: true }).sort({ createdAt: -1 });
    res.status(200).json({
      success: true,
      count: banks.length,
      data: banks,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Server Error: Unable to fetch blood bank directory data.",
      error: err.message,
    });
  }
};

module.exports = { getBloodBanks };
