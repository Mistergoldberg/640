import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestIsCurrent,
  shouldCancelYearRequest,
  touchBoundedYearCache,
  YEAR_COLLECTION_CACHE_CAPACITY
} from "./archiveYearCache";
import { loadAlbumResults } from "./useArchiveYearCache";
import type { AlbumSummary } from "../types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bounded archive year cache", () => {
  it("keeps the active year and two adjacent/restorable full collections", () => {
    let order: string[] = [];
    order = touchBoundedYearCache(order, "2013").order;
    order = touchBoundedYearCache(order, "2002").order;
    const update = touchBoundedYearCache(order, "2001");
    expect(YEAR_COLLECTION_CACHE_CAPACITY).toBe(3);
    expect(update.order).toEqual(["2013", "2002", "2001"]);
    expect(update.evicted).toEqual([]);
  });

  it("refreshes a revisited year before evicting the least recent collection", () => {
    const refreshed = touchBoundedYearCache(["2013", "2002", "2001"], "2013");
    expect(refreshed.order).toEqual(["2002", "2001", "2013"]);
    expect(touchBoundedYearCache(refreshed.order, "2000")).toEqual({
      order: ["2001", "2013", "2000"],
      evicted: ["2002"]
    });
  });

  it("rejects stale, aborted, and obsolete target work", () => {
    expect(requestIsCurrent(4, 4)).toBe(true);
    expect(requestIsCurrent(5, 4)).toBe(false);
    expect(requestIsCurrent(4, 4, true)).toBe(false);
    expect(shouldCancelYearRequest("2001", "2013")).toBe(true);
    expect(shouldCancelYearRequest("2013", "2013")).toBe(false);
  });

  it("limits concurrent album manifest requests while preserving result order", async () => {
    let active = 0;
    let maxActive = 0;
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      fetched.push(url);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        ok: true,
        json: async () => ({ photos: [] })
      };
    });
    const albums: AlbumSummary[] = Array.from({ length: 8 }, (_, index) => ({
      id: `album-${index}`,
      name: `Album ${index}`,
      count: 0,
      manifestUrl: `data/test/album-${index}.json`
    }));

    const results = await loadAlbumResults(albums, new AbortController().signal, 3);

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(fetched).toHaveLength(8);
    expect(results).toHaveLength(8);
    expect(results.map((result) => result.status)).toEqual(Array(8).fill("fulfilled"));
    expect(results.map((result) => result.status === "fulfilled" ? result.value.album.id : "")).toEqual(albums.map((album) => album.id));
  });
});
