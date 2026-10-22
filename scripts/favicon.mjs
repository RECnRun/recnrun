// Writes apps/website/icons/favicon.svg: the logo on a transparent background (docs/BRAND.md).
import { writeFileSync } from "node:fs";
import { layers } from "./logo.mjs";

const round = (n) => Math.round(n * 100) / 100;

const element = (shape, attributes) =>
  shape.type === "circle"
    ? `<circle cx="${round(shape.cx)}" cy="${round(shape.cy)}" r="${round(shape.r)}"${attributes}/>`
    : `<path d="M${shape.points.map(([x, y]) => `${round(x)} ${round(y)}`).join("L")}Z"${attributes}/>`;

const clips = layers.flatMap(({ clip }, i) =>
  clip ? [`<clipPath id="clip${i}">${element(clip, "")}</clipPath>`] : [],
);
const shapes = layers.map(({ color, shape, clip }, i) =>
  element(shape, `${clip ? ` clip-path="url(#clip${i})"` : ""} fill="${color}"`),
);

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  (clips.length ? `<defs>${clips.join("")}</defs>` : "") +
  shapes.join("") +
  `</svg>\n`;

writeFileSync(new URL("../apps/website/icons/favicon.svg", import.meta.url), svg);
