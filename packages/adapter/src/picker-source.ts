import { RECORDER_OVERLAY_PREFIX } from "@recnrun/protocol";

// Runs in an isolated world: it shares the DOM with the page but none of its globals. A shield
// covers the viewport, so a click lands on the overlay (excluded from suggestions) and never on
// the application's element; the element under the pointer is found with elementsFromPoint.
const PICKER = `(function (config) {
  "use strict";
  if (globalThis.__recnrunPickerStop) return;
  const ATTRIBUTES = [["id", "id"], ["data-testid", "testId"], ["name", "name"], ["role", "role"], ["type", "inputType"]];
  const fixed = "position:fixed;z-index:2147483647;";
  const shield = document.createElement("div");
  shield.id = config.prefix + "-picker";
  shield.style.cssText = fixed + "inset:0;cursor:crosshair;background:transparent;";
  const box = document.createElement("div");
  box.id = config.prefix + "-highlight";
  box.style.cssText = fixed + "pointer-events:none;outline:2px solid #1c7ed6;display:none;";
  const own = (element) => element.id.startsWith(config.prefix);
  const under = (event) => document.elementsFromPoint(event.clientX, event.clientY).find((e) => !own(e));
  const describe = (element) => {
    const out = { tag: element.localName };
    for (const [attribute, key] of ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value) out[key] = value.slice(0, config.maxText);
    }
    return out;
  };
  const outline = (event) => {
    const element = under(event);
    if (!element) return void (box.style.display = "none");
    const r = element.getBoundingClientRect();
    box.style.cssText += "display:block;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;";
  };
  const swallow = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const pick = (event) => {
    swallow(event);
    const element = under(event);
    if (element) globalThis[config.binding](JSON.stringify(describe(element)));
  };
  shield.addEventListener("mousemove", outline);
  shield.addEventListener("click", pick, true);
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "auxclick", "contextmenu"])
    shield.addEventListener(type, swallow, true);
  document.documentElement.append(shield, box);
  globalThis.__recnrunPickerStop = () => {
    shield.remove();
    box.remove();
    delete globalThis.__recnrunPickerStop;
  };
})`;

export const PICKER_STOP = "globalThis.__recnrunPickerStop?.()";

/** The overlay script, called with the binding it reports picked elements through. */
export function pickerSource(binding: string, maxText: number): string {
  return `${PICKER}(${JSON.stringify({ prefix: RECORDER_OVERLAY_PREFIX, binding, maxText })});`;
}
