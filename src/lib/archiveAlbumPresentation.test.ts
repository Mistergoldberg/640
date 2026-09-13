import { describe, expect, it } from "vitest";
import { formatArchiveAlbumLabel } from "./albumDisplayLabel";
import { formatPublicArchiveAlbumLabel, publicArchiveAlbumFolderLabel } from "./archiveAlbumPresentation";

describe("archive album presentation labels", () => {
  it("corrects the public 2002 Thailand album title without changing the source identity", () => {
    const sourceFolderLabel = "2002-Thialand";

    expect(publicArchiveAlbumFolderLabel(sourceFolderLabel)).toBe("2002-Thailand");
    expect(formatPublicArchiveAlbumLabel(sourceFolderLabel, "2002")).toBe("2002-Thailand");
    expect(formatArchiveAlbumLabel(sourceFolderLabel, "2002")).toBe("2002-Thialand");
    expect(sourceFolderLabel).toBe("2002-Thialand");
  });
});
