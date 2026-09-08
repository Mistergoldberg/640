import { describe, expect, it } from "vitest";
import { boundedDiagnosticEvents, diagnosticModeEnabled, type DiagnosticEvent } from "./archiveDiagnostics";

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
});
