import { byTestId, count, show, start } from "../fixture.js";

const TOTAL = 10_000;
const ROW_HEIGHT = 32;
const OVERSCAN = 5;
const MAX_RENDERED = 200;

const list = byTestId("list");
const spacer = byTestId("spacer");
const rendered = new Map();
spacer.style.height = `${TOTAL * ROW_HEIGHT}px`;

function createRow(index) {
  const row = document.createElement("div");
  row.className = "virtual-row";
  row.setAttribute("role", "listitem");
  row.dataset.testid = `row-${index}`;
  row.dataset.key = `row-key-${index}`;
  row.style.top = `${index * ROW_HEIGHT}px`;
  const label = document.createElement("span");
  label.textContent = `Row ${index}`;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.testid = `row-button-${index}`;
  button.textContent = `Select row ${index}`;
  row.append(label, button);
  return row;
}

/** Keeps exactly the visible rows (plus overscan) in the DOM, reusing rows by key. */
function render() {
  const first = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleEnd = Math.ceil((list.scrollTop + list.clientHeight) / ROW_HEIGHT);
  const last = Math.min(TOTAL - 1, visibleEnd + OVERSCAN);
  for (const [index, row] of rendered) {
    if (index < first || index > last) {
      row.remove();
      rendered.delete(index);
    }
  }
  for (let index = first; index <= last; index += 1) {
    if (!rendered.has(index)) rendered.set(index, spacer.appendChild(createRow(index)));
  }
  list.dataset.rendered = String(rendered.size);
}

list.addEventListener("scroll", render);
list.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  if (!button) return;
  count("selections");
  show("selected", button.textContent.replace("Select", "Selected"));
});

function renderVisibleRows() {
  render();
  if (rendered.size === 0 || rendered.size >= MAX_RENDERED) {
    throw new Error(`Rendered ${rendered.size} rows; expected only the visible ones`);
  }
}

await start("virtual-list", { counters: ["selections"], selfTest: renderVisibleRows });
