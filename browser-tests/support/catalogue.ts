import fs from "node:fs";
import path from "node:path";

type Catalog = { years: Array<{ year: string; indexUrl: string }> };
type YearIndex = { year: string; albums: Array<{ id: string; name: string; manifestUrl: string }>; sequence: Array<{ id: string }> };
type Photo = { id: string; thumbnailKey: string; displayKey: string; width: number; height: number; orientation: "portrait" | "landscape" };

const APP_ROOT = path.resolve(import.meta.dirname, "../..");
const read = <T>(relativePath: string): T => JSON.parse(fs.readFileSync(path.join(APP_ROOT, "public", relativePath), "utf8"));

export function currentCatalogueFixture() {
  const catalog = read<Catalog>("data/catalog.json");
  if (catalog.years.length < 3) throw new Error("Current-catalogue acceptance requires at least three years");
  const years = catalog.years.map((entry) => entry.year);
  const newest = catalog.years[0];
  const adjacent = catalog.years[1];
  const oldest = catalog.years.at(-1)!;
  const index = read<YearIndex>(newest.indexUrl);
  const manifests = index.albums.map((album) => read<{ photos: Photo[] }>(album.manifestUrl));
  const photos = manifests.flatMap((manifest) => manifest.photos);
  const portrait = photos.find((photo) => photo.orientation === "portrait");
  const landscape = photos.find((photo) => photo.orientation === "landscape");
  if (!portrait || !landscape) throw new Error(`Newest catalogue year ${newest.year} lacks representative orientations`);
  return { years, newest: newest.year, adjacent: adjacent.year, oldest: oldest.year, index, portrait, landscape };
}
