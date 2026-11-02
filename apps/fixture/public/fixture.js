// Shared by every page: the window.__fixture contract, counters, ?fail, and the self-test.

const CONTROLS = "a[href], button, input, select, textarea, iframe";

/** The defect injected with `?fail=<case>`, or "" when none. */
export const failCase = new URLSearchParams(location.search).get("fail") ?? "";

const state = {
  route: "",
  ready: false,
  counters: {},
  fail: failCase,
  // Unchanged across pushState navigations; a reload gives a new one.
  loadId: crypto.randomUUID(),
  // Set by the page's inline head script, which runs before this module.
  hookSeenAtHead: window.__fixture?.hookSeenAtHead === true,
};
window.__fixture = state;

/** Returns the element with this data-testid, or throws so the self-test fails. */
export function byTestId(testId) {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`Missing [data-testid="${testId}"]`);
  return element;
}

export function show(testId, text) {
  byTestId(testId).textContent = text;
}

export function count(name) {
  state.counters[name] = (state.counters[name] ?? 0) + 1;
  return state.counters[name];
}

/** Runs the handler on every click of the control and counts it under the counter name. */
export function onClick(testId, counter, handler) {
  byTestId(testId).addEventListener("click", (event) => {
    count(counter);
    handler(event);
  });
}

/** Appends this page's `?fail=` to an API path, so the server can inject the defect. */
export function withFail(path) {
  return failCase ? `${path}?fail=${encodeURIComponent(failCase)}` : path;
}

function accessibleName(element) {
  const label = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "";
  const labels = [...(element.labels ?? [])].map((each) => each.textContent ?? "").join(" ");
  return `${label} ${labels} ${element.textContent ?? ""}`.trim();
}

/** Every control has a stable data-testid and an accessible name. */
function checkControls() {
  const problems = [];
  for (const element of document.querySelectorAll(CONTROLS)) {
    const id = element.getAttribute("data-testid");
    if (!id) problems.push(`${element.outerHTML.slice(0, 60)} has no data-testid`);
    else if (!accessibleName(element)) problems.push(`[data-testid="${id}"] has no name`);
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
}

/**
 * Starts a page: zeroes its counters, runs the shared and the page's own self-test, then sets
 * `window.__fixture.ready`. With `?fail=throw` it raises an uncaught error right after.
 */
export async function start(route, { counters = [], selfTest } = {}) {
  state.route = route;
  for (const name of counters) state.counters[name] = 0;
  try {
    checkControls();
    await selfTest?.();
    state.ready = true;
    document.documentElement.dataset.ready = "true";
  } catch (error) {
    state.error = String(error);
    console.error(`Fixture self-test failed on ${route}:`, error);
  }
  if (failCase === "throw") {
    setTimeout(() => {
      throw new Error("Injected failure (fail=throw)");
    });
  }
}
