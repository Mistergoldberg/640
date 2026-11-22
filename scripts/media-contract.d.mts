export interface MediaKeyExpectation {
  year?: string;
  photoId?: string;
  derivative?: "thumbs" | "display";
}

export type MediaKeyInspection =
  | { valid: false; reason: string }
  | { valid: true; pathYear: string; derivative: "thumbs" | "display"; photoId: string; contentDigest: string };

export const CONTENT_VERSION: "cv1";
export const CONTENT_VERSIONED_MEDIA_KEY: RegExp;
export function inspectMediaKey(key: unknown, expected?: MediaKeyExpectation): MediaKeyInspection;
export function isSupportedMediaKey(key: unknown, expected?: MediaKeyExpectation): boolean;
