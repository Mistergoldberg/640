import { describe, expect, it } from "vitest";
import {
  requestIsCurrent,
  shouldCancelYearRequest,
  touchBoundedYearCache,
  YEAR_COLLECTION_CACHE_CAPACITY
} from "./archiveYearCache";

describe("bounded archive year cache", () => {
  it("keeps only the active and most recently used full collections", () => {
    let order: string[] = [];
    order = touchBoundedYearCache(order, "2013").order;
    order = touchBoundedYearCache(order, "2002").order;
    const update = touchBoundedYearCache(order, "2001");
    expect(YEAR_COLLECTION_CACHE_CAPACITY).toBe(2);
    expect(update.order).toEqual(["2002", "2001"]);
    expect(update.evicted).toEqual(["2013"]);
  });

  it("refreshes a revisited year before evicting the least recent collection", () => {
    const refreshed = touchBoundedYearCache(["2013", "2002"], "2013");
    expect(refreshed.order).toEqual(["2002", "2013"]);
    expect(touchBoundedYearCache(refreshed.order, "2001")).toEqual({
      order: ["2013", "2001"],
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
});
