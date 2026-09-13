import { describe, expect, it } from "vitest";
import { formatArchiveAlbumLabel } from "./albumDisplayLabel";

describe("formatArchiveAlbumLabel", () => {
  it("prefixes date-like labels with their parent year", () => {
    expect(formatArchiveAlbumLabel("09-03", "2013")).toBe("2013-09-03");
    expect(formatArchiveAlbumLabel("10-09", "2013")).toBe("2013-10-09");
  });

  it("prefixes descriptive labels without changing their text", () => {
    expect(formatArchiveAlbumLabel("Thailand", "2002")).toBe("2002-Thailand");
    expect(formatArchiveAlbumLabel("WHEN-CANADA", "2002")).toBe("2002-WHEN-CANADA");
  });

  it("does not duplicate an existing parent-year prefix", () => {
    expect(formatArchiveAlbumLabel("2002-Thailand", "2002")).toBe("2002-Thailand");
    expect(formatArchiveAlbumLabel("2013-10-09", "2013")).toBe("2013-10-09");
  });

  it("trims only accidental outer whitespace", () => {
    expect(formatArchiveAlbumLabel("  09-03  ", "2013")).toBe("2013-09-03");
    expect(formatArchiveAlbumLabel("  Trip, Day 1  ", "2002")).toBe("2002-Trip, Day 1");
  });

  it("keeps edit and pixel suffixes as separate display suffixes", () => {
    expect(formatArchiveAlbumLabel("2013-10-09/edit", "2013")).toBe("2013-10-09 · Edit");
    expect(formatArchiveAlbumLabel("10-09 · Edit", "2013")).toBe("2013-10-09 · Edit");
    expect(formatArchiveAlbumLabel("2013-10-09/pixel", "2013")).toBe("2013-10-09 · Pixel");
  });
});
