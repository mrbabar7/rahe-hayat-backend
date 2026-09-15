const { Donor, DonationRequest } = require("../../models/formModel");

exports.showLandingPageDonors = async (req, res) => {
  try {
    const currentUserId = req.user ? req.user.id || req.user._id : null;
    const { bloodType, district, province } = req.query;

    const today = new Date();

    let query = {
      $or: [{ nextAvailableDate: { $gt: today } }, { isAvailable: true }],
      isSuspended: { $ne: true },
      appearsInPublicSearch: { $ne: false },
    };

    if (currentUserId) {
      query.userId = { $ne: currentUserId };
    }
    if (bloodType) {
      query.bloodType = bloodType;
    }
    if (province) {
      query.province = province;
    }
    if (district) {
      query.district = { $regex: `^${district.trim()}$`, $options: "i" };
    }

    const donors = await Donor.find(query);

    const donorsWithStatus = await Promise.all(
      donors.map(async (donor) => {
        let request = null;
        if (currentUserId) {
          request = await DonationRequest.findOne({
            seekerId: currentUserId,
            donorId: donor._id,
          });
        }

        let daysRemaining = 0;
        if (donor.nextAvailableDate) {
          const nextDate = new Date(donor.nextAvailableDate);
          if (nextDate > today) {
            const diffTime = nextDate - today;
            daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          }
        }

        return {
          ...donor.toObject(),
          daysRemaining: daysRemaining,
          mobileNumber:
            request && request.status === "accepted"
              ? donor.mobileNumber
              : null,
          requestStatus: request ? request.status : null,
          requestId: request ? request._id : null,
        };
      }),
    );

    res.status(200).json(donorsWithStatus);
  } catch (error) {
    console.error("Backend Error:", error);
    res.status(500).json([]);
  }
};
