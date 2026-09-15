const { Donor } = require("../../models/formModel");

exports.checkDonorProfileRegister = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const donor = await Donor.findOne({ userId: userId });
    res.status(200).json({ registered: !!donor, donor });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};
