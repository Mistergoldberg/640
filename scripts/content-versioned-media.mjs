import crypto from "node:crypto";

export const CONTENT_MEDIA_KEY_VERSION = 1;
const SUPPORTED_MEDIA_KEY_PATTERN = /^(?:19|20)\d{2}\/(?:thumbs|display)\/(?:19|20)\d{2}-[a-f0-9]{14}(?:-cv[1-9]\d*-[a-f0-9]{64})?\.(?:jpg|jpeg|png|webp|gif|tif|tiff|heic|heif)$/i;

export function isSupportedMediaKey(value) {
  return typeof value === "string" && SUPPORTED_MEDIA_KEY_PATTERN.test(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function encodingRecipeIdentity({ derivativeType, recipe, sharpVersion }) {
  if (!new Set(["thumbnail", "display"]).has(derivativeType)) {
    throw new Error(`Unsupported derivative type for content-versioned key: ${derivativeType}`);
  }
  if (!recipe || !(typeof recipe.version === "string" || typeof recipe.version === "number")) {
    throw new Error("A versioned derivative recipe is required for content-versioned keys");
  }
  if (!sharpVersion || typeof sharpVersion !== "string") {
    throw new Error("The Sharp version is required for content-versioned keys");
  }
  const identity = {
    schemaVersion: CONTENT_MEDIA_KEY_VERSION,
    derivativeType,
    encoder: { name: "sharp", version: sharpVersion },
    recipeVersion: recipe.version,
    settings: recipe[derivativeType] || null
  };
  return { identity, sha256: sha256(stableJson(identity)) };
}

export function contentVersionedMediaAsset({ year, photoId, sourceSha256, derivativeType, recipe, sharpVersion }) {
  if (!/^\d{4}$/.test(String(year))) throw new Error(`Invalid media-key year: ${year}`);
  if (!new RegExp(`^${year}-[a-f0-9]{14}$`, "i").test(String(photoId))) {
    throw new Error(`Invalid photo identity for media key: ${photoId}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(sourceSha256))) throw new Error(`Invalid source SHA-256 for ${photoId}`);
  const recipeIdentity = encodingRecipeIdentity({ derivativeType, recipe, sharpVersion });
  const keyIdentity = {
    schemaVersion: CONTENT_MEDIA_KEY_VERSION,
    photoId,
    sourceSha256: sourceSha256.toLowerCase(),
    derivativeType,
    recipeIdentitySha256: recipeIdentity.sha256
  };
  const keyIdentitySha256 = sha256(stableJson(keyIdentity));
  const directory = derivativeType === "thumbnail" ? "thumbs" : "display";
  return {
    key: `${year}/${directory}/${photoId}-cv${CONTENT_MEDIA_KEY_VERSION}-${keyIdentitySha256}.jpg`,
    keyIdentity,
    keyIdentitySha256,
    recipeIdentity: recipeIdentity.identity,
    recipeIdentitySha256: recipeIdentity.sha256
  };
}
