function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return joinUrl(base, path);
}

export function mediaUrl(assetKey: string): string {
  const configuredBase = import.meta.env.VITE_MEDIA_BASE_URL?.trim();
  const base = configuredBase || assetUrl("media");
  return joinUrl(base, assetKey);
}
