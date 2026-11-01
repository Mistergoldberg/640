import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiagnosticErrorBoundary } from "./ArchiveDiagnosticsPanel";

describe("public render failure recovery", () => {
  it("offers accurate recovery controls without requiring unavailable diagnostics", () => {
    const boundary = new DiagnosticErrorBoundary({ children: <div>archive</div> });
    boundary.state = { failed: true };
    const markup = renderToStaticMarkup(boundary.render());
    expect(markup).toContain("Reload page");
    expect(markup).toContain("Return to archive");
    expect(markup).not.toContain("Export");
    expect(markup).not.toContain("private failure");
  });
});
