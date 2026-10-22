// Logo geometry shared by the favicon and the extension icons (docs/BRAND.md).
const palette = {
  red: "#f3362b",
  green: "#30b050",
  yellow: "#fecc03",
};

// Measured on docs/brand/logo-fundo-transparente.svg, in the coordinates of its inner group.
const disc = { type: "circle", cx: 259, cy: 217, r: 162 };
const play = {
  type: "polygon",
  points: [
    [96.5, 230],
    [381, 392.5],
    [96.5, 555],
  ],
};
// Painted in order: the record dot, the play triangle, and their overlap in yellow.
const artwork = [
  { color: palette.red, shape: disc },
  { color: palette.green, shape: play },
  { color: palette.yellow, shape: play, clip: disc },
];

const bounds = (shape) =>
  shape.type === "circle"
    ? [
        [shape.cx - shape.r, shape.cy - shape.r],
        [shape.cx + shape.r, shape.cy + shape.r],
      ]
    : shape.points;

const points = artwork.flatMap(({ shape }) => bounds(shape));
const range = (values) => [Math.min(...values), Math.max(...values)];
const [xs, ys] = [range(points.map(([x]) => x)), range(points.map(([, y]) => y))];
const scale = 30 / Math.max(xs[1] - xs[0], ys[1] - ys[0]);
const fit = ([x, y]) => [
  16 + (x - (xs[0] + xs[1]) / 2) * scale,
  16 + (y - (ys[0] + ys[1]) / 2) * scale,
];
const fitShape = (shape) => {
  if (shape.type === "polygon") return { type: "polygon", points: shape.points.map(fit) };
  const [cx, cy] = fit([shape.cx, shape.cy]);
  return { type: "circle", cx, cy, r: shape.r * scale };
};

/** Logo layers, bottom to top, centered in a 32 × 32 box with a 1-unit margin. */
export const layers = artwork.map(({ color, shape, clip }) => ({
  color,
  shape: fitShape(shape),
  clip: clip && fitShape(clip),
}));
