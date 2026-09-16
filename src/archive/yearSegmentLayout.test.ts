import { describe, expect, it } from "vitest";
import {
  buildYearSegmentLayout,
  segmentHeightFromRowPlan,
  type GridLayout
} from "./yearSegmentLayout";
import {
  beginSegmentLoad,
  completeSegmentLoad,
  createYearSegmentController,
  mountedSegmentCount,
  retainedCollectionCount,
  mountSegment,
  type YearSegmentControllerState
} from "./yearSegmentController";
import { buildArchiveTimelineModel, orderedArchiveYears } from "./archiveTimelineModel";
import { buildYearCollection, type AlbumLoadResult, type YearCollection } from "../data/useYearCollection";
import type { AlbumManifest, AlbumSummary, Catalog, Photo, YearIndex } from "../types";

const DIMENSIONS = [
  [640, 480],
  [480, 640],
  [512, 512],
  [800, 450],
  [450, 800],
  [1024, 576],
  [720, 540],
  [300, 500]
] as const;

function orientation(width: number, height: number): Photo["orientation"] {
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}

function syntheticPhoto(year: string, albumId: string, sortPosition: number, albumSortPosition: number): Photo {
  const [width, height] = DIMENSIONS[sortPosition % DIMENSIONS.length];
  return {
    id: `${year}-${String(sortPosition).padStart(6, "0")}`,
    thumbnailKey: "fixtures/shared-thumb.webp",
    displayKey: "fixtures/shared-display.webp",
    albumId,
    width,
    height,
    orientation: orientation(width, height),
    sortPosition,
    albumSortPosition
  };
}

function syntheticYearCollection(
  year: string,
  photoCount: number,
  albumCount: number,
  options: { rejectedRecord?: boolean } = {}
): YearCollection {
  const albums: AlbumSummary[] = [];
  const results: AlbumLoadResult[] = [];
  const sequence: Array<{ id: string }> = [];
  let sortPosition = 0;
  const boundedAlbumCount = photoCount > 0 ? Math.max(1, albumCount) : albumCount;

  for (let albumIndex = 0; albumIndex < boundedAlbumCount; albumIndex += 1) {
    const remainingAlbums = boundedAlbumCount - albumIndex;
    const remainingPhotos = photoCount - sortPosition;
    const count = remainingAlbums > 0 ? Math.ceil(remainingPhotos / remainingAlbums) : 0;
    const album: AlbumSummary = {
      id: `${year}-album-${albumIndex + 1}`,
      name: `${year}-${albumIndex + 1}`,
      count,
      manifestUrl: `data/${year}/albums/${albumIndex + 1}.json`
    };
    const photos: Photo[] = [];
    for (let albumSortPosition = 0; albumSortPosition < count; albumSortPosition += 1) {
      const photo = syntheticPhoto(year, album.id, sortPosition, albumSortPosition);
      photos.push(photo);
      sequence.push({ id: photo.id });
      sortPosition += 1;
    }
    albums.push(album);
    results.push({ status: "ready", album, manifest: { photos } satisfies AlbumManifest });
  }

  if (options.rejectedRecord) {
    sequence.splice(Math.min(2, sequence.length), 0, { id: `${year}-rejected-missing-record` });
  }

  const sourceIndex: YearIndex = {
    year,
    scannedCount: sequence.length,
    albums,
    sequence
  };
  return buildYearCollection([year], sourceIndex, results);
}

function layoutFor(collection: YearCollection, width: number, viewportHeight = 900): GridLayout {
  const compactViewport = viewportHeight <= 460 && width >= 620;
  const targetRowHeight = compactViewport ? 184 : width < 520 ? 138 : width < 900 ? 146 : 174;
  const gap = width < 520 ? 3 : 4;
  return buildYearSegmentLayout({ collection, width, targetRowHeight, gap, compactViewport });
}

function nodeRuntime() {
  return (globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>;
      memoryUsage?: () => { heapUsed: number };
    };
  }).process;
}

function heapUsed() {
  return nodeRuntime()?.memoryUsage?.().heapUsed || 0;
}

function reportScaleMetrics(metrics: Record<string, unknown>) {
  if (nodeRuntime()?.env?.REPORT_SEGMENT_SCALE === "1") {
    console.log(JSON.stringify({ type: "segment-scale", ...metrics }));
  }
}

function loadSegment(
  state: YearSegmentControllerState<YearCollection, GridLayout>,
  year: string,
  collection: YearCollection,
  width = 768
) {
  const { state: loading, request } = beginSegmentLoad(state, year);
  const rowPlan = layoutFor(collection, width);
  const completed = completeSegmentLoad(loading, {
    year,
    generation: request.generation,
    collection,
    rowPlan,
    width,
    height: segmentHeightFromRowPlan(rowPlan)
  });
  expect(completed.stale).toBe(false);
  return completed.state;
}

describe("year segment deterministic layout", () => {
  it("uses the row plan total as the segment height at responsive widths", () => {
    const collection = syntheticYearCollection("2040", 96, 4);
    const widths = [320, 390, 768, 1024, 1440];
    const heights = widths.map((width) => {
      const layout = layoutFor(collection, width);
      expect(segmentHeightFromRowPlan(layout)).toBe(layout.totalHeight);
      expect(layout.entries.every((entry) => entry.top >= 0 && entry.height > 0)).toBe(true);
      expect(layout.photoTops.size).toBe(collection.availableCount);
      return layout.totalHeight;
    });

    expect(new Set(heights).size).toBeGreaterThan(1);
  });

  it("handles empty years and rejected metadata without fabricating photo anchors", () => {
    const empty = syntheticYearCollection("2039", 0, 0);
    expect(empty.availableCount).toBe(0);
    expect(layoutFor(empty, 390).totalHeight).toBe(0);

    const withRejectedRecord = syntheticYearCollection("2038", 12, 2, { rejectedRecord: true });
    const rejectedId = "2038-rejected-missing-record";
    const layout = layoutFor(withRejectedRecord, 390);
    expect(withRejectedRecord.expectedCount).toBe(13);
    expect(withRejectedRecord.availableCount).toBe(12);
    expect(layout.photoTops.has(rejectedId)).toBe(false);
  });
});

describe("year segment synthetic scale model", () => {
  it("builds a large metadata-only year without creating DOM or image elements", () => {
    const started = performance.now();
    const huge = syntheticYearCollection("2037", 100_000, 40, { rejectedRecord: true });
    const collectionElapsedMs = performance.now() - started;
    const activeLayoutStarted = performance.now();
    const activeLayout = layoutFor(huge, 1024);
    const activeLayoutElapsedMs = performance.now() - activeLayoutStarted;
    const adjacentLayoutStarted = performance.now();
    const adjacentLayout = layoutFor(huge, 390);
    const adjacentLayoutElapsedMs = performance.now() - adjacentLayoutStarted;

    expect(huge.expectedCount).toBe(100_001);
    expect(huge.availableCount).toBe(100_000);
    expect(activeLayout.photoTops.size).toBe(100_000);
    expect(adjacentLayout.totalHeight).toBeGreaterThan(activeLayout.totalHeight);
    expect(activeLayout.entries.length).toBeLessThan(100_000);
    expect(collectionElapsedMs).toBeLessThan(5_000);
    expect(activeLayoutElapsedMs + adjacentLayoutElapsedMs).toBeLessThan(10_000);
    expect(typeof document === "undefined" ? 0 : document.querySelectorAll("img").length).toBe(0);
    reportScaleMetrics({
      scenario: "huge-year",
      metadataRecords: huge.expectedCount,
      availableRecords: huge.availableCount,
      collectionElapsedMs: Math.round(collectionElapsedMs * 100) / 100,
      activeLayoutElapsedMs: Math.round(activeLayoutElapsedMs * 100) / 100,
      adjacentLayoutElapsedMs: Math.round(adjacentLayoutElapsedMs * 100) / 100,
      activeLayoutEntries: activeLayout.entries.length,
      adjacentLayoutEntries: adjacentLayout.entries.length,
      activeHeight: activeLayout.totalHeight,
      adjacentHeight: adjacentLayout.totalHeight,
      domImageElements: typeof document === "undefined" ? 0 : document.querySelectorAll("img").length
    });
  }, 20_000);

  it("keeps controller work proportional to active and adjacent segments across many years", () => {
    const years = Array.from({ length: 25 }, (_, index) => String(2045 - index));
    const catalog: Catalog = {
      years: years.map((year) => ({ year, indexUrl: `data/${year}/index.json` }))
    };
    const collections = new Map(years.map((year, index) => [year, syntheticYearCollection(year, index % 6 === 0 ? 0 : 48 + index, 3)]));
    const indexes = new Map([...collections].map(([year, collection]) => [year, collection.sourceIndex]));
    const summaryStarted = performance.now();
    const timeline = buildArchiveTimelineModel(catalog, indexes);
    const summaryElapsedMs = performance.now() - summaryStarted;

    expect(orderedArchiveYears(catalog).map((entry) => entry.year)).toEqual(years);
    expect(timeline.years).toHaveLength(25);
    expect(summaryElapsedMs).toBeLessThan(1_000);

    const heapBeforeController = heapUsed();
    let state = createYearSegmentController<YearCollection, GridLayout>({
      years,
      activeYear: years[10],
      catalogueRevision: "synthetic-many-years",
      maxMountedSegments: 2,
      maxRetainedCollections: 3
    });

    for (const year of [years[10], years[9], years[11], years[0], years[24]]) {
      state = loadSegment(state, year, collections.get(year)!);
      state = mountSegment(state, year, year === years[10]);
    }

    expect(mountedSegmentCount(state)).toBeLessThanOrEqual(2);
    expect(retainedCollectionCount(state)).toBeLessThanOrEqual(3);
    expect(retainedCollectionCount(state)).toBeLessThan(years.length);
    expect(state.segments.get(years[10])?.containsVisualAnchor).toBe(true);
    expect(state.segments.get(years[10])?.status).toBe("mounted");
    const heapAfterController = heapUsed();
    const retainedPhotoRecords = [...state.retainedCollections.values()]
      .reduce((sum, entry) => sum + entry.collection.photos.length, 0);
    reportScaleMetrics({
      scenario: "many-years-controller",
      representedYears: years.length,
      timelineYears: timeline.years.length,
      globalSummaryElapsedMs: Math.round(summaryElapsedMs * 100) / 100,
      mountedSegments: mountedSegmentCount(state),
      retainedCollections: retainedCollectionCount(state),
      retainedPhotoRecords,
      heapDeltaBytes: heapBeforeController && heapAfterController ? heapAfterController - heapBeforeController : null
    });
  });
});
