import { assetUrl, mediaUrl } from '../lib/assets';
import { validateYearIndex } from '../data/manifestValidation';
import { buildYearCollection, fetchJson } from '../data/useYearCollection';
import { loadAlbumResults } from '../archive/useArchiveYearCache';
import { orderedArchiveYears } from '../archive/archiveTimelineModel';
import type { Catalog, Photo } from '../types';

export interface PlayerYear { year: string; photos: Photo[] }
interface Entry { controller: AbortController; promise: Promise<PlayerYear>; images: HTMLImageElement[] }

// This cache belongs to one open player. Keep only the current year and its neighbours.
export class PlayerYearLoader {
  readonly years: string[];
  private entries = new Map<string, Entry>();
  constructor(private catalog: Catalog | null) {
    this.years = catalog ? orderedArchiveYears(catalog).map(item => item.year) : [];
  }
  adjacent(year: string, direction: -1 | 1) {
    const index = this.years.indexOf(year);
    return index < 0 ? null : this.years[index + direction] ?? null;
  }
  load(year: string): Promise<PlayerYear> {
    const cached = this.entries.get(year);
    if (cached) return cached.promise;
    const summary = this.catalog?.years.find(item => item.year === year);
    if (!summary) return Promise.reject(new Error('Year unavailable'));
    const controller = new AbortController();
    const images: HTMLImageElement[] = [];
    controller.signal.addEventListener('abort', () => images.forEach(image => image.removeAttribute('src')), { once: true });
    const promise = (async () => {
      const timeout = globalThis.setTimeout(() => controller.abort(), 30_000);
      try {
      const index = validateYearIndex(await fetchJson(assetUrl(summary.indexUrl), controller.signal), year);
      const settled = await loadAlbumResults(index, controller.signal, 3);
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const results = settled.map(item => {
        if (item.status !== 'fulfilled') throw new Error('Year unavailable');
        return item.value;
      });
      const collection = buildYearCollection(this.years, index, results);
      if (collection.isIncomplete || !collection.photos.length) throw new Error('Year unavailable');
      // Decode the lead-in before committing the boundary; do not discard the current frame.
      await Promise.all(collection.photos.slice(0, 5).map(async (photo, position) => {
        const image = new Image(); images.push(image);
        image.decoding = 'async'; image.src = mediaUrl(photo.displayKey);
        try { await image.decode(); } catch { if (position === 0) throw new Error('Year unavailable'); }
      }));
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      return { year, photos: collection.photos };
      } finally { globalThis.clearTimeout(timeout); }
    })();
    this.entries.set(year, { controller, promise, images });
    return promise;
  }
  retain(year: string) {
    const keep = new Set([year, this.adjacent(year, -1), this.adjacent(year, 1)]);
    for (const key of this.entries.keys()) if (!keep.has(key)) this.remove(key);
  }
  remove(year: string) {
    const entry = this.entries.get(year);
    entry?.controller.abort();
    entry?.images.forEach(image => { image.onload = null; image.onerror = null; image.removeAttribute('src'); });
    this.entries.delete(year);
  }
  dispose() { for (const year of this.entries.keys()) this.remove(year); }
  get size() { return this.entries.size; }
}
