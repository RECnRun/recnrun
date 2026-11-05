import { render } from "preact";
import { h } from "preact";
import { DiagnosticsPage } from "@/diagnostics/DiagnosticsPage";
import { startDiagnostics } from "@/diagnostics/start";
import "@recnrun/brand/base.css";
import "@recnrun/brand/mona-sans.css";
import "@/diagnostics/diagnostics.css";

const report = await startDiagnostics();
const root = document.getElementById("app");
if (root) render(h(DiagnosticsPage, { report }), root);
