import { describe, expect, it } from "vitest";
import type { Catalog } from "../types";
import { resolvePhotoAlias, validatePhotoAliasMap } from "./photoAliasResolution";

const catalog: Catalog = {
  years: [
    { year: "2001", indexUrl: "data/2001/index.json" },
    { year: "2026", indexUrl: "data/2026/index.json" }
  ]
};
const digest = "a".repeat(64);
const base = {
  schemaVersion: 1,
  status: "approved",
  packageId: digest,
  packageClosedWorldSha256: digest,
  transitionLedgerSha256: digest,
  aliases: [],
  retired: []
};

describe("legacy public photo alias resolution", () => {
  it("accepts a sealed map and resolves same-year and cross-year aliases", () => {
    const map = validatePhotoAliasMap({
      ...base,
      aliases: [
        { oldYear: "2001", oldPhotoId: "2001-00000000000001", newYear: "2001", newPhotoId: "2001-00000000000002" },
        { oldYear: "2001", oldPhotoId: "2001-00000000000003", newYear: "2026", newPhotoId: "2026-00000000000004" }
      ]
    }, catalog);

    expect(resolvePhotoAlias(map, "2001", "2001-00000000000001")).toEqual({
      status: "alias", year: "2001", photoId: "2001-00000000000002"
    });
    expect(resolvePhotoAlias(map, "2001", "2001-00000000000003")).toEqual({
      status: "alias", year: "2026", photoId: "2026-00000000000004"
    });
  });

  it("allows multiple legacy IDs to resolve to one current photo", () => {
    const map = validatePhotoAliasMap({
      ...base,
      aliases: [
        { oldYear: "2001", oldPhotoId: "2001-00000000000001", newYear: "2026", newPhotoId: "2026-00000000000004" },
        { oldYear: "2001", oldPhotoId: "2001-00000000000002", newYear: "2026", newPhotoId: "2026-00000000000004" }
      ]
    }, catalog);
    expect(resolvePhotoAlias(map, "2001", "2001-00000000000001")).toEqual(
      resolvePhotoAlias(map, "2001", "2001-00000000000002")
    );
  });

  it("distinguishes explicitly retired and unknown IDs", () => {
    const map = validatePhotoAliasMap({
      ...base,
      retired: [{ oldYear: "2001", oldPhotoId: "2001-00000000000005" }]
    }, catalog);
    expect(resolvePhotoAlias(map, "2001", "2001-00000000000005")).toEqual({ status: "retired" });
    expect(resolvePhotoAlias(map, "2001", "2001-00000000000006")).toEqual({ status: "unchanged" });
    expect(resolvePhotoAlias(null, "2001", "2001-00000000000005")).toEqual({ status: "unchanged" });
  });

  it("rejects unapproved, malformed, duplicate, conflicting, and unavailable targets", () => {
    expect(() => validatePhotoAliasMap({ ...base, status: "provisional" }, catalog)).toThrow("status must be approved");
    expect(() => validatePhotoAliasMap({ ...base, packageId: "not-a-digest" }, catalog)).toThrow("packageId");
    const alias = { oldYear: "2001", oldPhotoId: "2001-00000000000001", newYear: "2026", newPhotoId: "2026-00000000000004" };
    expect(() => validatePhotoAliasMap({ ...base, aliases: [alias, alias] }, catalog)).toThrow("duplicates an old photo ID");
    expect(() => validatePhotoAliasMap({ ...base, aliases: [alias], retired: [{ oldYear: "2001", oldPhotoId: "2001-00000000000001" }] }, catalog)).toThrow("duplicates an old photo ID");
    expect(() => validatePhotoAliasMap({ ...base, aliases: [{ ...alias, newYear: "2025", newPhotoId: "2025-00000000000004" }] }, catalog)).toThrow("outside the catalogue");
    expect(() => validatePhotoAliasMap({ ...base, aliases: [{ ...alias, oldPhotoId: "2026-00000000000001" }] }, catalog)).toThrow("does not match its year");
  });
});
