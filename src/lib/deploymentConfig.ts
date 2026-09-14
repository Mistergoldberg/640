export function resolveDeploymentConfig(mode: string, env: Record<string, string | undefined>) {
  const production = mode === "production";
  const base = env.VITE_APP_BASE_PATH?.trim() || (production ? "/" : "/640/");
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) {
    throw new Error("VITE_APP_BASE_PATH must be an absolute path ending in /, such as / or /640/");
  }

  const mediaBaseUrl = env.VITE_MEDIA_BASE_URL?.trim() ||
    (production ? "https://media.pixilation.org/" : "");
  if (mediaBaseUrl) {
    const url = new URL(mediaBaseUrl);
    if (!["https:", ...(production ? [] : ["http:"])].includes(url.protocol) ||
        url.username || url.password || url.search || url.hash) {
      throw new Error("VITE_MEDIA_BASE_URL must be a public media URL without credentials, query or fragment; production requires HTTPS");
    }
  }
  return { base, mediaBaseUrl };
}
