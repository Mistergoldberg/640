const HUMANIZED_ALBUM_SUFFIXES: Array<[string, string]> = [
  ["/edit", " · Edit"],
  ["/pixel", " · Pixel"]
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function humanizeAlbumPathSuffix(folderLabel: string) {
  for (const [suffix, displaySuffix] of HUMANIZED_ALBUM_SUFFIXES) {
    if (folderLabel.endsWith(suffix)) {
      return `${folderLabel.slice(0, -suffix.length)}${displaySuffix}`;
    }
  }

  return folderLabel;
}

export function formatArchiveAlbumLabel(folderLabel: string, parentYear: string) {
  const displayName = humanizeAlbumPathSuffix(folderLabel.trim());
  if (!displayName) {
    return parentYear;
  }

  if (parentYear && new RegExp(`^${escapeRegExp(parentYear)}(?:$|\\D)`).test(displayName)) {
    return displayName;
  }

  return `${parentYear}-${displayName}`;
}
