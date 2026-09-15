const { Donor, DonationRequest } = require("../../models/formModel");
const Address = require("../../models/addressModel");
const Broadcast = require("../../models/broadcastModel");
const { createNotification } = require("../notificationController");

// POST /seeker/post-request
// Implements PDF screen 14 (Post a Request) + fans out to matching nearby donors,
// producing the live-trackable broadcast used by screen 17 (Emergency Broadcast).
exports.postRequest = async (req, res) => {
  try {
    const seekerId = req.user.id || req.user._id;
    const {
      requestedBloodType,
      hospitalName,
      hospitalPhone,
      units,
      urgency,
      fullName,
      phone,
      province,
      city,
      addressLine,
      latitude,
      longitude,
    } = req.body;

    if (!requestedBloodType || !hospitalName || !fullName || !phone || !province || !city || !addressLine) {
      return res.status(400).json({
        success: false,
        message: "Please fill in blood group, hospital, and your contact details.",
      });
    }

    // Keep the seeker's saved address in sync (same pattern as addAddress), so
    // future requests / the address book stay consistent with what was typed here.
    await Address.updateMany({ user: seekerId }, { $set: { isPrimary: false } });
    await Address.create({ user: seekerId, fullName, phone, province, city, addressLine, isPrimary: true });

    const broadcast = await Broadcast.create({
      seekerId,
      requestedBloodType,
      hospitalName,
      hospitalPhone: hospitalPhone || "",
      units: Number(units) || 1,
      urgency: urgency === "critical" ? "critical" : "within_24h",
      seekerName: fullName,
      seekerPhone: phone,
      seekerLocation: {
        province,
        city,
        addressLine,
        latitude: latitude != null ? Number(latitude) : null,
        longitude: longitude != null ? Number(longitude) : null,
      },
    });

    // Match available donors of the right blood type, nearby by district/province.
    const donors = await Donor.find({
      userId: { $ne: seekerId },
      bloodType: requestedBloodType,
      isAvailable: true,
      isSuspended: { $ne: true },
      appearsInPublicSearch: { $ne: false },
      $or: [
        { district: new RegExp(`^${city}$`, "i") },
        { province: new RegExp(`^${province}$`, "i") },
      ],
    }).limit(60);

    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + 7);

    if (donors.length > 0) {
      await DonationRequest.insertMany(
        donors.map((d) => ({
          seekerId,
          donorId: d._id,
          broadcastId: broadcast._id,
          requestedBloodType,
          status: "pending",
          seekerName: fullName,
          seekerPhone: phone,
          seekerLocation: { province, city, addressLine },
          expireAt,
        }))
      );
    }

    broadcast.donorsNotified = donors.length;
    await broadcast.save();

    await Promise.all(
      donors.map((d) =>
        createNotification({
          userId: d.userId,
          title: urgency === "critical" ? "🚨 Urgent Blood Requirement!" : "Blood Requirement Nearby",
          message: `${fullName} needs ${requestedBloodType} at ${hospitalName}, ${city}.`,
          link: "/(tabs)/home",
        })
      )
    );

    res.status(201).json({
      success: true,
      message:
        donors.length > 0
          ? `Broadcast sent to ${donors.length} nearby donor(s).`
          : "Request posted, but no matching donors were found nearby yet.",
      broadcastId: broadcast._id,
      donorsNotified: donors.length,
    });
  } catch (error) {
    console.error("Post Request Error:", error);
    res.status(500).json({ success: false, message: "Failed to post request", error: error.message });
  }
};
