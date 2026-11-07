// W7 slice C: what the worker holds pressed in its tab, and the events that let all of it go.
const MOUSE = "Input.dispatchMouseEvent";
const KEY = "Input.dispatchKeyEvent";
const CANCEL = "Input.cancelDragging";

export const createHeld = () => {
  /** @type {Set<string>} buttons pressed and not released */
  const buttons = new Set();
  /** @type {Map<string, any>} key code → its keyUp params */
  const keys = new Map();
  let at = { x: 0, y: 0 };

  const trackMouse = (params) => {
    if (params.type === "mouseWheel") return;
    at = { x: params.x, y: params.y };
    if (params.type === "mousePressed") buttons.add(params.button);
    if (params.type === "mouseReleased") buttons.delete(params.button);
  };

  const trackKey = (params) => {
    if (params.type === "keyUp") {
      keys.delete(params.code);
      return;
    }
    const { key, code, windowsVirtualKeyCode } = params;
    keys.set(code, { type: "keyUp", key, code, windowsVirtualKeyCode, modifiers: 0 });
  };

  /** Records a command before it is sent: one that times out may have pressed. */
  const track = (method, params) => {
    if (method === MOUSE) trackMouse(params);
    else if (method === KEY) trackKey(params);
  };

  // Keys go up first, so a held modifier never turns the button's release into another action.
  const releases = () => [
    ...[...keys.values()].map((params) => ({ method: KEY, params })),
    ...[...buttons].map((button) => ({
      method: MOUSE,
      params: { type: "mouseReleased", ...at, button, clickCount: 1, modifiers: 0 },
    })),
  ];

  const size = () => buttons.size + keys.size;
  const any = () => size() > 0;

  const clear = () => {
    buttons.clear();
    keys.clear();
  };

  /**
   * Cancels any drag, then lets go of every key and button through `send(method, params)`; each
   * stays tracked until its release is confirmed. False when the pressed state is not known.
   */
  const releaseAll = async (send) => {
    // A drag cancelled first ends without a drop, whatever is under the pointer.
    const cancelled = await send(CANCEL, {}).then(
      () => true,
      (error) => String(error?.message) !== "INPUT_UNKNOWN",
    );
    let sure = cancelled;
    for (const { method, params } of releases()) {
      const done = await send(method, params).then(
        () => true,
        () => false,
      );
      if (done) track(method, params);
      sure &&= done;
    }
    return sure && !any();
  };

  return { track, releases, releaseAll, clear, size, any };
};
