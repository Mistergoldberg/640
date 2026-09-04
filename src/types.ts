export type Orientation = "landscape" | "portrait" | "square";

export interface Photo {
  id: string;
  thumbnailKey: string;
  displayKey: string;
  albumId: string;
  width: number;
  height: number;
  orientation: Orientation;
  sortPosition: number;
  albumSortPosition: number;
}

export interface AlbumSummary {
  id: string;
  name: string;
  count: number;
  manifestUrl: string;
}

export interface PhotoSequenceItem {
  id: string;
}

export interface AlbumManifest {
  photos: Photo[];
}

export interface YearIndex {
  year: string;
  scannedCount: number;
  albums: AlbumSummary[];
  sequence: PhotoSequenceItem[];
}

export interface CatalogYear {
  year: string;
  indexUrl: string;
}

export interface Catalog {
  years: CatalogYear[];
}

export interface PhotoCollection {
  year: string;
  index: YearIndex;
  albums: AlbumManifest[];
  photos: Photo[];
}
