import { describe, expect, it } from "vitest";
import {
  boundedDiagnosticEvents,
  createIdempotentSetup,
  diagnosticModeEnabled,
  diagnosticsExport,
  getDiagnostics,
  redactDiagnosticUrl,
  sanitizeDiagnosticData,
  type DiagnosticEvent
} from "./archiveDiagnostics";

function event(sequence: number): DiagnosticEvent {
  return { sequence, type: `event-${sequence}`, at: "2026-09-08T00:00:00.000Z", elapsedMs: sequence };
}

describe("archive diagnostics", () => {
  it("enables only for an exact debug=1 query value", () => {
    expect(diagnosticModeEnabled("?debug=1")).toBe(true);
    expect(diagnosticModeEnabled("?year=2001&debug=1")).toBe(true);
    expect(diagnosticModeEnabled("?debug=true")).toBe(false);
    expect(diagnosticModeEnabled("")).toBe(false);
  });

  it("retains only the newest bounded events", () => {
    const events = Array.from({ length: 205 }, (_, index) => event(index + 1))
      .reduce((current, next) => boundedDiagnosticEvents(current, next), [] as DiagnosticEvent[]);
    expect(events).toHaveLength(200);
    expect(events[0].sequence).toBe(6);
    expect(events[199].sequence).toBe(205);
  });

  it("redacts URL values, error details, private paths, and sensitive fields", () => {
    expect(redactDiagnosticUrl("https://pixilation.org/?year=2026&token=secret#private")).toBe(
      "https://pixilation.org/?token=%5Bredacted%5D&year=%5Bredacted%5D"
    );
    expect(sanitizeDiagnosticData({
      message: "private failure",
      nested: { url: "https://pixilation.org/?email=person@example.com", source: "/Users/person/private/file.ts" },
      token: "secret",
      safe: "visible"
    })).toEqual({
      message: "[redacted]",
      nested: { url: "https://pixilation.org/?email=%5Bredacted%5D", source: "[redacted]" },
      token: "[redacted]",
      safe: "visible"
    });
  });

  it("uses one minimized redacted snapshot for every export path", () => {
    const exported = diagnosticsExport({
      ...getDiagnostics(),
      url: "https://pixilation.org/?year=2026&secret=value#fragment",
      events: [{ ...event(1), data: { message: "private", url: "https://example.com/?token=value" } }]
    });
    expect(exported).not.toHaveProperty("userAgent");
    expect(exported).not.toHaveProperty("platform");
    expect(exported.url).toBe("https://pixilation.org/?secret=%5Bredacted%5D&year=%5Bredacted%5D");
    expect(exported.events[0].data).toEqual({ message: "[redacted]", url: "https://example.com/?token=%5Bredacted%5D" });
  });

  it("deduplicates initialization and releases retained work exactly once", () => {
    let setups = 0;
    let cleanups = 0;
    const initialize = createIdempotentSetup(() => {
      setups += 1;
      return () => { cleanups += 1; };
    });
    const firstDispose = initialize();
    const secondDispose = initialize();
    expect(setups).toBe(1);
    expect(firstDispose).toBe(secondDispose);
    firstDispose();
    secondDispose();
    expect(cleanups).toBe(1);
    initialize()();
    expect({ setups, cleanups }).toEqual({ setups: 2, cleanups: 2 });
  });
});
