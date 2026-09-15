const { Donor, DonationRequest } = require("./../models/formModel");
const Hospital = require("../models/hospitalModel");
const BloodBank = require("../models/bankModel");
const Ambulance = require("../models/ambulanceModel");
const NGO = require("../models/ngoModel");

// GET /stats — public, real counts for the guest home hero + About Us (PDF screens
// 30 & 38 both show numeric stats — this replaces what would otherwise be fabricated).
exports.getPlatformStats = async (req, res) => {
  try {
    const [totalDonors, completedRequests, hospitals, banks, ambulances, ngos] = await Promise.all([
      Donor.countDocuments(),
      DonationRequest.countDocuments({ status: "completed" }),
      Hospital.countDocuments(),
      BloodBank.countDocuments(),
      Ambulance.countDocuments(),
      NGO.countDocuments(),
    ]);

    res.status(200).json({
      success: true,
      totalDonors,
      livesSupported: completedRequests,
      partnerFacilities: hospitals + banks + ambulances + ngos,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
