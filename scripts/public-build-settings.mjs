export function publicFlagEnabled(value) {
  return value === "1" || value?.toLowerCase() === "true";
}

export function publicBuildSettings(env = process.env) {
  return {
    appBasePath: env.VITE_APP_BASE_PATH?.trim() || "/",
    mediaBaseUrl: env.VITE_MEDIA_BASE_URL?.trim() || "https://media.pixilation.org/",
    homepageAutoplayer: publicFlagEnabled(env.VITE_HOMEPAGE_AUTOPLAYER),
    seamlessYearSegments: publicFlagEnabled(env.VITE_SEAMLESS_YEAR_SEGMENTS)
  };
}
