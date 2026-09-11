import type { ArchiveTarget, ArchiveTimelineModel } from "./archiveTimelineModel";
import type { ArchiveLoadReason } from "./useArchiveYearCache";

export type ArchiveNavigationIntent =
  | "initial"
  | "scrub"
  | "jump"
  | "boundary"
  | "history"
  | "photo-close";

export interface ArchiveNavigationPlan {
  intent: ArchiveNavigationIntent;
  target: ArchiveTarget;
  historyMode: "push" | "replace" | null;
  loadReason: ArchiveLoadReason;
}

export function createArchiveNavigationPlan(target: ArchiveTarget, intent: ArchiveNavigationIntent): ArchiveNavigationPlan {
  const historyMode = intent === "history" ? null
    : intent === "scrub" || intent === "jump" || intent === "boundary" ? "push"
      : "replace";
  const loadReason: ArchiveLoadReason = intent === "initial" ? "initial"
    : intent === "photo-close" ? "history"
      : intent;
  return { intent, target, historyMode, loadReason };
}

export function boundaryArchiveTarget(
  model: ArchiveTimelineModel,
  activeYear: string,
  direction: "newer" | "older"
): ArchiveTarget | null {
  const yearIndex = model.years.findIndex((candidate) => candidate.year === activeYear);
  if (yearIndex < 0) return null;
  const targetYear = model.years[yearIndex + (direction === "older" ? 1 : -1)];
  if (!targetYear) return null;
  const album = direction === "older" ? targetYear.albums[0] : targetYear.albums[targetYear.albums.length - 1];
  const ratio = direction === "older" ? targetYear.start : Math.max(targetYear.start, targetYear.end - Number.EPSILON);
  return {
    year: targetYear.year,
    albumId: album?.id || null,
    albumName: album?.name || null,
    ratio,
    sectionRatio: direction === "older" ? 0 : 1
  };
}

export function stableYearLocalCorrection(previousTop: number | undefined, nextTop: number | undefined) {
  if (previousTop === undefined || nextTop === undefined) return 0;
  return nextTop - previousTop;
}

export interface MountedArchiveCounts {
  mountedYears: string[];
  mountedRows: number;
  mountedPhotos: number;
  inactiveImageElements: number;
  observerCount: number;
}

export function archiveWindowWarnings(counts: MountedArchiveCounts) {
  const warnings: string[] = [];
  if (counts.mountedYears.length > 1) warnings.push("multiple-mounted-years");
  if (counts.mountedPhotos > 170) warnings.push("photo-tile-bound-exceeded");
  if (counts.mountedRows > 40) warnings.push("row-bound-exceeded");
  if (counts.inactiveImageElements > 0) warnings.push("inactive-year-images");
  if (counts.observerCount > 2) warnings.push("stale-archive-observers");
  return warnings;
}
