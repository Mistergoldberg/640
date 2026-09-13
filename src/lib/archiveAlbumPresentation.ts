import { formatArchiveAlbumLabel } from "./albumDisplayLabel";

const PUBLIC_ALBUM_TITLE_OVERRIDES = new Map<string, string>([
  ["2002-Thialand", "2002-Thailand"]
]);

export function publicArchiveAlbumFolderLabel(folderLabel: string) {
  return PUBLIC_ALBUM_TITLE_OVERRIDES.get(folderLabel.trim()) || folderLabel;
}

export function formatPublicArchiveAlbumLabel(folderLabel: string, parentYear: string) {
  return formatArchiveAlbumLabel(publicArchiveAlbumFolderLabel(folderLabel), parentYear);
}
