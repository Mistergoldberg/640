import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

type Catalog = { years: Array<{ year: string; indexUrl: string }> };
type YearIndex = { year: string; albums: Array<{ id: string; name: string; manifestUrl: string }>; sequence: Array<{ id: string }> };
type Photo = { id: string; thumbnailKey: string; displayKey: string; width: number; height: number; orientation: "portrait" | "landscape" };

const APP_ROOT = path.resolve(import.meta.dirname, "../..");
const read = <T>(relativePath: string): T => JSON.parse(fs.readFileSync(path.join(APP_ROOT, "public", relativePath), "utf8"));

export const SYNTHETIC_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==", "base64");

export async function installSyntheticMedia(page: Page, failedKeys: readonly string[] = []) {
  await page.route("https://media.pixilation.org/**", (route) => {
    const failed = failedKeys.some((key) => route.request().url().endsWith(key));
    return route.fulfill(failed
      ? { status: 503, contentType: "text/plain", body: "synthetic failure" }
      : { status: 200, contentType: "image/jpeg", body: SYNTHETIC_JPEG });
  });
}

export function committedCatalogueIdentity() {
  const root = path.join(APP_ROOT, "public", "data");
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        files.push({
          path: path.relative(root, absolute).split(path.sep).join("/"),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex")
        });
      }
    }
  };
  visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    fileCount: files.length,
    treeSha256: createHash("sha256").update(JSON.stringify(files)).digest("hex")
  };
}

export function currentCatalogueFixture() {
  const catalog = read<Catalog>("data/catalog.json");
  if (catalog.years.length < 3) throw new Error("Current-catalogue acceptance requires at least three years");
  const years = catalog.years.map((entry) => entry.year);
  const newest = catalog.years[0];
  const adjacent = catalog.years[1];
  const oldest = catalog.years.at(-1)!;
  const index = read<YearIndex>(newest.indexUrl);
  const manifests = index.albums.map((album) => read<{ photos: Photo[] }>(album.manifestUrl));
  const photosById = new Map(manifests.flatMap((manifest) => manifest.photos).map((photo) => [photo.id, photo]));
  const photos = index.sequence.map(({ id }) => photosById.get(id)).filter((photo): photo is Photo => Boolean(photo));
  if (photos.length !== index.sequence.length) throw new Error(`Newest catalogue year ${newest.year} is incomplete`);
  const portrait = photos.find((photo) => photo.orientation === "portrait");
  const landscape = photos.find((photo) => photo.orientation === "landscape");
  if (!portrait || !landscape) throw new Error(`Newest catalogue year ${newest.year} lacks representative orientations`);
  return { years, newest: newest.year, adjacent: adjacent.year, third: catalog.years[2].year, oldest: oldest.year, index, photos, portrait, landscape };
}
