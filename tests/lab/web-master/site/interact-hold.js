// W7 slice D: while the owner holds a button or key still, the master tells the worker it is there.
const EVERY_MS = 200;
const TICK_MS = 50;

/** `sendHold()` sends one hold; nothing else sent for EVERY_MS while anything is held sends one. */
export const createHold = (sendHold) => {
  const buttons = new Set();
  const keys = new Set();
  let lastSentAt = 0;
  let enabled = true;
  let holds = 0;
  const any = () => buttons.size + keys.size > 0;

  setInterval(() => {
    if (!enabled || !any() || performance.now() - lastSentAt < EVERY_MS) return;
    lastSentAt = performance.now();
    holds += 1;
    void sendHold();
  }, TICK_MS);

  return {
    /** Any input event sent counts: it re-arms the worker's dead man as a hold does. */
    sent: () => {
      lastSentAt = performance.now();
    },
    press: (button) => void buttons.add(button),
    release: (button) => buttons.delete(button),
    holds: (button) => buttons.has(button),
    key: (code, down) => (down ? keys.add(code) : keys.delete(code)),
    // A master that loses focus stops vouching: the worker's dead man lets go within a second.
    clear: () => {
      buttons.clear();
      keys.clear();
    },
    // Lab only: off, the master sends nothing while held, as a master that hangs.
    enable: (on) => {
      enabled = on;
      return true;
    },
    stats: () => ({ holds, held: buttons.size + keys.size, enabled }),
  };
};
