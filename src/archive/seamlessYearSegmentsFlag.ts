import { publicFlagEnabled } from "../lib/publicFlag";

export const SEAMLESS_YEAR_SEGMENTS_ENV = "VITE_SEAMLESS_YEAR_SEGMENTS";

export function seamlessYearSegmentsEnabled(value = import.meta.env.VITE_SEAMLESS_YEAR_SEGMENTS) {
  return publicFlagEnabled(value);
}

export const SEAMLESS_YEAR_SEGMENTS_ENABLED = seamlessYearSegmentsEnabled();
