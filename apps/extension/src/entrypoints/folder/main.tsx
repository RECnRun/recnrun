import { startFolder } from "@/folder/start";
import { createPeerClient } from "@/views/peer-client";
import "@recnrun/brand/base.css";
import "@recnrun/brand/mona-sans.css";
import "@/views/views.css";
import "@/folder/folder.css";

const root = document.getElementById("app");
if (root) startFolder(root, createPeerClient());
