/**
 * imageUpload.js
 * ---------------------------------------------------------------------------
 * Self-contained (no third-party storage service) image upload handler.
 *
 * The mobile app picks an image with `expo-image-picker` and sends it as a
 * base64 data URI string (e.g. "data:image/jpeg;base64,/9j/4AAQ...") inside
 * the normal JSON body — there's no multipart/form-data involved, so no
 * multer/busboy is needed here.
 *
 * This module:
 *   1. Validates the data URI (mime type + declared size).
 *   2. Verifies the file's real signature ("magic bytes") matches the
 *      claimed type, so a renamed/spoofed file can't sneak through.
 *   3. Writes the decoded bytes to disk under /public/images/<folder>/...
 *   4. Returns a fully-qualified URL (using PUBLIC_API_URL / BACKEND_SERVER)
 *      that the app can drop straight into an <Image source={{ uri }} />.
 *   5. Cleans up the previous file when an entry's image is replaced/removed,
 *      so /public/images doesn't grow forever with orphaned files.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// backend/public/images
const IMAGES_ROOT = path.join(__dirname, "..", "public", "images");

// Allowed formats per the request: jpg/jpeg, png, webp.
const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// First few bytes of each format — used to confirm the file actually is
// what its data-URI header claims to be.
const SIGNATURES = {
  jpg: [[0xff, 0xd8, 0xff]],
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // WEBP = "RIFF" .... "WEBP" (bytes 8-11), so we check both anchors.
  webp: [[0x52, 0x49, 0x46, 0x46]],
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB decoded

const DATA_URI_REGEX = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

class ImageUploadError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImageUploadError";
    this.status = 400;
  }
}

const ensureDir = (dir) => fs.promises.mkdir(dir, { recursive: true });

const bufferMatchesSignature = (buffer, ext) => {
  const candidates = SIGNATURES[ext];
  if (!candidates) return false;
  return candidates.some((sig) => sig.every((byte, i) => buffer[i] === byte));
};

const bufferLooksLikeWebp = (buffer) =>
  buffer.length > 12 &&
  buffer.toString("ascii", 0, 4) === "RIFF" &&
  buffer.toString("ascii", 8, 12) === "WEBP";

/**
 * Builds the absolute base URL used to serve uploaded images, e.g.
 * "https://api.example.com". Falls back through the env vars this project
 * already defines, and finally to a same-origin-relative path if none are set
 * (still works fine for local development against the Expo web build).
 */
const getPublicBaseUrl = () => {
  const fromEnv =
    process.env.PUBLIC_API_URL || process.env.BACKEND_SERVER || "";
  return fromEnv.replace(/\/+$/, "");
};

/**
 * Turns a stored relative path ("/images/ngo/xxx.jpg") into the absolute URL
 * the app needs for <Image source={{ uri }} />.
 */
const toPublicUrl = (relativePath) => `${getPublicBaseUrl()}${relativePath}`;

/**
 * True if the given field looks like a fresh upload (a base64 data URI)
 * rather than an already-stored URL that was just echoed back by the app
 * (e.g. when editing a listing without changing its photo).
 */
const isDataUri = (value) => typeof value === "string" && DATA_URI_REGEX.test(value);

/**
 * Saves a base64 data-URI image to disk under public/images/<folder>/.
 * Returns the absolute public URL to store on the document.
 */
const saveBase64Image = async (dataUri, folder) => {
  const match = DATA_URI_REGEX.exec(dataUri);
  if (!match) {
    throw new ImageUploadError("Invalid image data. Please choose the photo again.");
  }

  const mime = match[1].toLowerCase();
  const ext = MIME_TO_EXT[mime];
  if (!ext) {
    throw new ImageUploadError(
      "Unsupported image format. Please upload a JPG, PNG, or WEBP image.",
    );
  }

  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    throw new ImageUploadError("The uploaded image appears to be empty.");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ImageUploadError("Image is too large. Please use an image under 5MB.");
  }

  const validSignature =
    ext === "webp" ? bufferLooksLikeWebp(buffer) : bufferMatchesSignature(buffer, ext);
  if (!validSignature) {
    throw new ImageUploadError(
      "This file doesn't look like a valid image. Please try a different photo.",
    );
  }

  const targetDir = path.join(IMAGES_ROOT, folder);
  await ensureDir(targetDir);

  const filename = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${ext}`;
  await fs.promises.writeFile(path.join(targetDir, filename), buffer);

  return toPublicUrl(`/images/${folder}/${filename}`);
};

/**
 * Deletes a previously-stored image (safe no-op for missing files, external
 * URLs, or anything outside the images folder — never trust the path blindly).
 */
const deleteStoredImage = async (imageUrl) => {
  if (!imageUrl || typeof imageUrl !== "string") return;

  const marker = "/images/";
  const idx = imageUrl.indexOf(marker);
  if (idx === -1) return; // not one of our locally-stored images (e.g. external URL)

  const relative = imageUrl.slice(idx + marker.length); // "ngo/xxx.jpg"
  const resolved = path.join(IMAGES_ROOT, relative);

  // Guard against path traversal — resolved path must stay inside IMAGES_ROOT.
  if (!resolved.startsWith(IMAGES_ROOT + path.sep)) return;

  try {
    await fs.promises.unlink(resolved);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Failed to delete old image:", err.message);
    }
  }
};

/**
 * High-level helper used by the register/update controllers.
 *
 * - newValue is a fresh base64 data URI  -> save it, delete oldValue, return new URL
 * - newValue is "" (explicitly cleared)  -> delete oldValue, return ""
 * - newValue is undefined                -> field wasn't sent at all, leave untouched
 * - newValue is any other string         -> already a stored/external URL, keep as-is
 *
 * Returns undefined when the field should be left out of the update entirely.
 */
const resolveImageField = async (newValue, oldValue, folder) => {
  if (newValue === undefined) return undefined;

  if (newValue === null || newValue === "") {
    if (oldValue) await deleteStoredImage(oldValue);
    return "";
  }

  if (isDataUri(newValue)) {
    const savedUrl = await saveBase64Image(newValue, folder);
    if (oldValue) await deleteStoredImage(oldValue);
    return savedUrl;
  }

  // Unchanged existing URL echoed back from the edit form (or an external URL).
  return newValue;
};

module.exports = {
  ImageUploadError,
  IMAGES_ROOT,
  isDataUri,
  saveBase64Image,
  deleteStoredImage,
  resolveImageField,
  getPublicBaseUrl,
};
