export function installManualScrollRestoration(target: Pick<History, "scrollRestoration"> | null = typeof history === "undefined" ? null : history) {
  if (!target || !("scrollRestoration" in target)) return false;
  target.scrollRestoration = "manual";
  return target.scrollRestoration === "manual";
}

installManualScrollRestoration();
