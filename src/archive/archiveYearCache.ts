export function requestIsCurrent(currentGeneration: number, requestGeneration: number, aborted = false) {
  return currentGeneration === requestGeneration && !aborted;
}

export const YEAR_COLLECTION_CACHE_CAPACITY = 2;

export interface BoundedYearCacheUpdate {
  order: string[];
  evicted: string[];
}

/**
 * Tracks full year collections from least to most recently used. The catalogue
 * and lightweight year indexes live outside this cache.
 */
export function touchBoundedYearCache(
  currentOrder: readonly string[],
  year: string,
  capacity = YEAR_COLLECTION_CACHE_CAPACITY
): BoundedYearCacheUpdate {
  const boundedCapacity = Math.max(1, Math.floor(capacity));
  const order = [...currentOrder.filter((candidate) => candidate !== year), year];
  const evicted = order.slice(0, Math.max(0, order.length - boundedCapacity));
  return { order: order.slice(-boundedCapacity), evicted };
}

export function shouldCancelYearRequest(requestYear: string, targetYear: string) {
  return requestYear !== targetYear;
}
