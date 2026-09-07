export type ArchiveNavigationIntent = "passive" | "scrub" | "jump" | "photo";

export function historyModeForIntent(intent: ArchiveNavigationIntent): "replace" | "push" {
  return intent === "jump" || intent === "photo" ? "push" : "replace";
}
