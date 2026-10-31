export const HOMEPAGE_AUTOPLAYER_ENV = "VITE_HOMEPAGE_AUTOPLAYER";

export function homepageAutoplayerEnabled(value = import.meta.env.VITE_HOMEPAGE_AUTOPLAYER) {
  return value === "1" || value?.toLowerCase() === "true";
}

export const HOMEPAGE_AUTOPLAYER_ENABLED = homepageAutoplayerEnabled();

export function isEligibleHomepageAutoplayUrl(href: string, diagnostics = false) {
  const url = new URL(href, "https://pixilation.org");
  return url.pathname === "/"
    && !url.searchParams.has("year")
    && !url.searchParams.has("photo")
    && !url.searchParams.has("debug")
    && !diagnostics;
}

export interface HomepageAutoplayDocumentState {
  readonly eligible: boolean;
  readonly initialPath: string;
  dismissed: boolean;
}

export function createHomepageAutoplayDocumentState(
  href: string,
  enabled: boolean,
  diagnostics = false
): HomepageAutoplayDocumentState {
  const url = new URL(href, "https://pixilation.org");
  return {
    eligible: enabled && isEligibleHomepageAutoplayUrl(url.href, diagnostics),
    initialPath: `${url.pathname}${url.search}${url.hash}`,
    dismissed: false
  };
}

export function dismissHomepageAutoplayForDocument(state: HomepageAutoplayDocumentState) {
  state.dismissed = true;
}

export type HomepageWarmupPhase =
  | "inactive"
  | "loading-first-five"
  | "first-five-forward"
  | "first-five-backward"
  | "loading-next-ten"
  | "next-ten-forward"
  | "next-ten-backward"
  | "steady-forward"
  | "paused"
  | "error";

export function settledRange(statuses: ReadonlyMap<number, "ready" | "failed">, start: number, end: number) {
  for (let index = start; index < end; index += 1) {
    if (!statuses.has(index)) return false;
  }
  return true;
}

export function usableRange(statuses: ReadonlyMap<number, "ready" | "failed">, start: number, end: number) {
  const result: number[] = [];
  for (let index = start; index < end; index += 1) {
    if (statuses.get(index) === "ready") result.push(index);
  }
  return result;
}
