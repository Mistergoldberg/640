import "./archive/browserScrollRestoration";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ArchiveDiagnosticsPanel, DiagnosticErrorBoundary } from "./debug/ArchiveDiagnosticsPanel";
import { initializeDiagnostics } from "./debug/archiveDiagnostics";
import "./styles.css";

initializeDiagnostics();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DiagnosticErrorBoundary><App /></DiagnosticErrorBoundary>
    <ArchiveDiagnosticsPanel />
  </React.StrictMode>
);
