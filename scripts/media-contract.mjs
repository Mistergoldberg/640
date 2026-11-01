const YEAR = "(?:19|20)\\d{2}";
const PHOTO_DIGEST = "[a-f0-9]{14}";
const CONTENT_DIGEST = "[a-f0-9]{64}";

export const CONTENT_VERSION = "cv1";
export const CONTENT_VERSIONED_MEDIA_KEY = new RegExp(
  `^(?<pathYear>${YEAR})/(?<derivative>thumbs|display)/(?<photoYear>${YEAR})-(?<photoDigest>${PHOTO_DIGEST})-${CONTENT_VERSION}-(?<contentDigest>${CONTENT_DIGEST})\\.jpg$`
);

export function inspectMediaKey(key, expected = {}) {
  if (typeof key !== "string") return { valid: false, reason: "key must be a string" };
  const match = CONTENT_VERSIONED_MEDIA_KEY.exec(key);
  if (!match?.groups) return { valid: false, reason: "key does not match the cv1 media-key contract" };

  const { pathYear, derivative, photoYear, photoDigest, contentDigest } = match.groups;
  const photoId = `${photoYear}-${photoDigest}`;
  if (pathYear !== photoYear) return { valid: false, reason: "path year and photo-ID year differ" };
  if (expected.year && pathYear !== String(expected.year)) return { valid: false, reason: "key year differs from catalogue year" };
  if (expected.photoId && photoId !== expected.photoId) return { valid: false, reason: "key photo ID differs from manifest photo ID" };
  if (expected.derivative && derivative !== expected.derivative) return { valid: false, reason: "key derivative directory is incorrect" };

  return { valid: true, pathYear, derivative, photoId, contentDigest };
}

export function isSupportedMediaKey(key, expected) {
  return inspectMediaKey(key, expected).valid;
}
