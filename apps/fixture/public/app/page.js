export const API = "http://api.localhost:4601";
export const IDP = "http://idp.localhost:4602";

/** Records a named marker in the server ledger; pages await it before their first effect. */
export async function marker(name) {
  await fetch(`/__marker?name=${encodeURIComponent(name)}`, { cache: "no-store" });
}

/** The first-paint marker, sent after the page has rendered its results. */
export function firstPaint(page) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(() => resolve(marker(`${page}:first-paint`)), 0));
  });
}

export async function currentUser() {
  const response = await fetch(`${API}/me`, { credentials: "include" });
  return (await response.json()).user;
}

/** Runs one probe and reports its value or the exact error, so a refused API is visible. */
export async function attempt(run) {
  try {
    return await run();
  } catch (error) {
    return `error: ${error.name}: ${error.message}`;
  }
}

export function show(id, value) {
  const element = document.getElementById(id);
  element.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  element.dataset.ready = "true";
}
