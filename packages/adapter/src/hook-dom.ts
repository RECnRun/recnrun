// The hook's DOM capture, spliced into its body: it uses `config`, `ensure`, and `send` from there.
// Listeners sit on the window in the capture phase, so they see every event of the document
// (including ones the page stops) and survive the popup case where Chrome reuses the window.
// Scroll is debounced per scrolled node: one event with the final position after 100 ms of quiet.
// Password fields never report keys, data, or values; the event says `redacted` instead.
export const DOM_CAPTURE = `
  const clip = (value) => (typeof value === "string" ? value.slice(0, config.maxText) : undefined);
  const round = Math.round;
  const MODIFIERS = ["alt", "ctrl", "meta", "shift"];
  const ATTRIBUTES = [["id", "id"], ["data-testid", "testId"], ["name", "name"], ["role", "role"], ["type", "inputType"]];
  const elementOf = (node) => (node && node.nodeType === 1 ? node : null);
  const isSecret = (node) => Boolean(node && node.type === "password");
  const describe = (node) => {
    const element = elementOf(node);
    if (!element) return { tag: node && node.nodeType === 9 ? "#document" : "#window" };
    const out = { tag: element.localName };
    for (const [attribute, key] of ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value) out[key] = clip(value);
    }
    return out;
  };
  const modifiers = (event) => MODIFIERS.filter((name) => event[name + "Key"]);
  const pointer = (event) => ({
    x: round(event.clientX),
    y: round(event.clientY),
    button: event.button,
    pointerType: clip(event.pointerType || undefined),
    modifiers: modifiers(event),
  });
  const click = (event) => ({ ...pointer(event), detail: event.detail });
  const key = (event) =>
    isSecret(event.target)
      ? { redacted: true, modifiers: modifiers(event) }
      : { key: clip(event.key), code: clip(event.code), repeat: event.repeat, modifiers: modifiers(event) };
  const value = (node) => {
    if (!node || !("value" in node) || typeof node.value !== "string") return {};
    if (node.type === "checkbox" || node.type === "radio") return { checked: node.checked, value: clip(node.value) };
    return isSecret(node) ? { redacted: true } : { value: clip(node.value) };
  };
  const input = (event) => {
    const data = isSecret(event.target) ? undefined : event.data === null ? null : clip(event.data);
    return { inputType: clip(event.inputType), data, isComposing: event.isComposing, ...value(event.target) };
  };
  const selection = () => {
    const active = document.activeElement;
    if (active && typeof active.selectionStart === "number")
      return { selectionStart: active.selectionStart, selectionEnd: active.selectionEnd };
    const current = getSelection();
    return { selectedLength: current ? String(current).length : 0 };
  };
  const scrolled = (node) => {
    const element = elementOf(node);
    return element
      ? { scrollX: round(element.scrollLeft), scrollY: round(element.scrollTop) }
      : { scrollX: round(window.scrollX), scrollY: round(window.scrollY) };
  };
  const composition = (event) => (isSecret(event.target) ? { redacted: true } : { data: clip(event.data) });
  const DETAILS = {
    pointerdown: pointer, pointerup: pointer, click, dblclick: click,
    keydown: key, keyup: key, input, change: (event) => value(event.target),
    compositionstart: composition, compositionupdate: composition, compositionend: composition,
    selectionchange: selection, scroll: (event) => scrolled(event.target),
  };
  const post = (event) => {
    ensure();
    const details = DETAILS[event.type];
    send("dom", event.type, { target: describe(event.target), isTrusted: event.isTrusted, ...(details ? details(event) : {}) });
  };
  // A capture failure must never break the page.
  const safely = (work) => {
    try {
      work();
    } catch {}
  };
  const pendingScrolls = new Map();
  const onScroll = (event) => {
    clearTimeout(pendingScrolls.get(event.target));
    const fire = () => {
      pendingScrolls.delete(event.target);
      safely(() => post(event));
    };
    pendingScrolls.set(event.target, setTimeout(fire, 100));
  };
  for (const type of config.events) {
    const listener = type === "scroll" ? onScroll : post;
    window.addEventListener(type, (event) => safely(() => listener(event)), { capture: true, passive: true });
  }
`;
