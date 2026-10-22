import { render } from "preact";
import { Popup } from "@/popup/Popup";
import { readSnapshot } from "@/storage/snapshot-repository";
import "@/popup/popup.css";

const root = document.getElementById("app");
if (root) render(<Popup loadSnapshot={readSnapshot} />, root);
