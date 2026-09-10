import { describe, expect, it } from "vitest";
import type { Catalog } from "../types";
import {
  ARCHIVE_RESTORATION_SCHEMA,
  archiveCatalogueIdentity,
  archiveRestorationReducer,
  createArchiveRestorationState,
  createArchiveRestorationTarget,
  createStoredArchiveAnchor,
  ownedLegacyRestorationKeys,
  resolveAnchorAgainstStableIds,
  resolveNavigationRestoration,
  validateStoredArchiveAnchor
} from "./archiveRestoration";

const catalog: Catalog = { years: [
  { year: "2013", indexUrl: "data/2013/index.json" },
  { year: "2002", indexUrl: "data/2002/index.json" },
  { year: "2001", indexUrl: "data/2001/index.json" }
] };
const catalogueId = archiveCatalogueIdentity(catalog);
const valid = createStoredArchiveAnchor({ catalogueId, entryId: "entry-1", year: "2001", albumId: "album-1", photoId: "photo-1", adjustmentPx: 42 });
const historyState = { app: "640x480", entryId: "entry-1", year: "2001", photoId: null, view: "grid", fromGrid: false, restoration: valid };
const reportedRequestedPhoto = "2001-8117399092ce75";
const reportedWrongPhoto = "2001-52f7e219f9486a";

describe("archive restoration policy", () => {
  it("rejects unversioned legacy and unknown-schema records", () => {
    expect(validateStoredArchiveAnchor({ year: "2001", scrollY: 165736 }, { catalogueId, years: ["2013", "2002", "2001"] })).toBeNull();
    expect(validateStoredArchiveAnchor({ ...valid, schema: "continuous-archive-v0" }, { catalogueId, years: ["2013", "2002", "2001"] })).toBeNull();
  });

  it("gives an explicit URL precedence over unrelated saved history", () => {
    const target = resolveNavigationRestoration({ catalog, href: "https://example.test/?year=2013", historyState, navigationType: "reload", entryId: "new" });
    expect(target).toMatchObject({ year: "2013", albumId: null, photoId: null, source: "url" });
  });

  it("restores a valid current-schema anchor on reload", () => {
    const target = resolveNavigationRestoration({ catalog, href: "https://example.test/?year=2001", historyState, navigationType: "reload" });
    expect(target).toMatchObject({ ...valid, source: "history" });
  });

  it("keeps the exact reported URL photo when current-schema history conflicts", () => {
    const conflicting = {
      ...historyState,
      photoId: reportedWrongPhoto,
      view: "photo" as const,
      restoration: createStoredArchiveAnchor({
        catalogueId,
        entryId: historyState.entryId,
        year: "2001",
        photoId: reportedWrongPhoto
      })
    };
    const target = resolveNavigationRestoration({
      catalog,
      href: `https://example.test/?year=2001&photo=${reportedRequestedPhoto}`,
      historyState: conflicting,
      navigationType: "reload"
    });
    expect(target).toMatchObject({ year: "2001", photoId: reportedRequestedPhoto, source: "url" });
    expect(target.photoId).not.toBe(reportedWrongPhoto);
  });

  it.each([
    ["empty", null],
    ["malformed", { app: "640x480", entryId: "entry-1", restoration: "invalid" }],
    ["preceding schema", { ...historyState, restoration: { ...valid, schema: "continuous-archive-v0" } }],
    ["another year", {
      ...historyState,
      year: "2013",
      restoration: createStoredArchiveAnchor({ catalogueId, entryId: "entry-1", year: "2013", photoId: "2013-other" })
    }]
  ])("keeps the exact reported URL photo with %s stored state", (_label, storedState) => {
    const target = resolveNavigationRestoration({
      catalog,
      href: `https://example.test/?year=2001&photo=${reportedRequestedPhoto}`,
      historyState: storedState,
      navigationType: "reload",
      entryId: "fresh-entry"
    });
    expect(target).toMatchObject({ year: "2001", photoId: reportedRequestedPhoto, source: "url" });
  });

  it("falls back to the newest year for a new root navigation", () => {
    const target = resolveNavigationRestoration({ catalog, href: "https://example.test/", historyState, navigationType: "navigate", entryId: "root" });
    expect(target).toMatchObject({ year: "2013", source: "root", entryId: "root" });
  });

  it("falls back to the year when a stable album or photo no longer exists", () => {
    const result = resolveAnchorAgainstStableIds(valid, { layoutReady: true, albumIds: new Set(), photoIds: new Set() });
    expect(result).toEqual({ status: "ready", anchor: expect.objectContaining({ year: "2001", albumId: null, photoId: null, adjustmentPx: 0 }) });
  });

  it("constrains pixel adjustments to a valid anchor", () => {
    expect(createStoredArchiveAnchor({ ...valid, adjustmentPx: 165736 }).adjustmentPx).toBe(160);
    expect(createStoredArchiveAnchor({ ...valid, adjustmentPx: -165736 }).adjustmentPx).toBe(-160);
  });

  it("lets a newer navigation supersede stale coordinator events", () => {
    const first = archiveRestorationReducer(createArchiveRestorationState(), { type: "request", target: createArchiveRestorationTarget(valid, "history") });
    const nextAnchor = createStoredArchiveAnchor({ catalogueId, entryId: "entry-2", year: "2013" });
    const second = archiveRestorationReducer(first, { type: "request", target: createArchiveRestorationTarget(nextAnchor, "url") });
    expect(archiveRestorationReducer(second, { type: "apply", generation: first.generation })).toBe(second);
    expect(second.target?.year).toBe("2013");
  });

  it("cancels a pending restoration after user input", () => {
    const pending = archiveRestorationReducer(createArchiveRestorationState(), { type: "request", target: createArchiveRestorationTarget(valid, "history") });
    expect(archiveRestorationReducer(pending, { type: "cancel", generation: pending.generation }).phase).toBe("cancelled");
  });

  it("reconciles the active year from the settled visible position", () => {
    const pending = archiveRestorationReducer(createArchiveRestorationState(), { type: "request", target: createArchiveRestorationTarget(valid, "history") });
    const waiting = archiveRestorationReducer(pending, { type: "wait-for-layout", generation: pending.generation });
    const applying = archiveRestorationReducer(waiting, { type: "apply", generation: waiting.generation });
    const settled = archiveRestorationReducer(applying, { type: "settle", generation: applying.generation, visibleYear: "2001" });
    expect(settled).toMatchObject({ phase: "settled", settledYear: "2001" });
  });

  it("only identifies obsolete storage keys owned by this application", () => {
    expect(ownedLegacyRestorationKeys(["2013"])).toEqual(["640x480-selected-year", "640x480-scroll:2013", "640x480-anchor:2013"]);
    expect(ARCHIVE_RESTORATION_SCHEMA).toBe("year-window-archive-v1");
  });
});
