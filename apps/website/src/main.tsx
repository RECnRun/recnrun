import { render } from "preact";
import { App } from "@/app/App";
import { createExtensionGateway } from "@/services/extension";
import "@recnrun/brand/base.css";
import "@recnrun/brand/mona-sans.css";
import "@/app/app.css";

const root = document.getElementById("app");
if (root) render(<App gateway={createExtensionGateway()} />, root);
