const mongoose = require("mongoose");

const HospitalSchema = new mongoose.Schema({
  formType: {
    type: String,
    default: "Hospital",
  },
  name: {
    type: String,
    required: [true, "Hospital name is required"],
    trim: true,
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  orgType: {
    type: String,
    required: true,
    enum: ["Private", "Government", "Semi-Government", "Trust / NGO"],
  },
  timing: {
    type: String,
    required: [true, "Operating hours / timing are required"],
    default: "24/7 Service Available",
  },
  operatingDays: {
    type: [String],
    required: [true, "Operating days are required"],
    default: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  },
  phone: {
    type: String,
    required: false,
    default: "",
  },
  whatsapp: {
    type: String,
    required: [true, "WhatsApp number is required"],
    trim: true,
  },
  category: {
    type: [String],
    required: [true, "At least one category or specialty is required"],
  },
  website: {
    type: String,
    default: "",
    trim: true,
  },
  address: {
    type: String,
    required: [true, "Address is required"],
    trim: true,
  },
  // Base64 data-URI image uploaded from the registration form.
  image: { type: String, default: "" },
  isVerified: { type: Boolean, default: false },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Hospital", HospitalSchema);
