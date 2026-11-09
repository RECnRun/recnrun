// The file-signalled link: unlinked → connecting → linked → recovering → unlinked.
export const RECOVER_MS = 10_000;
export const CONNECT_MS = 20_000;

export const createLinkState = ({
  onChange,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  let state = "unlinked";
  let attempt = null;
  let timer = null;
  const move = (next, ms) => {
    if (timer !== null) clearTimer(timer);
    timer = ms ? setTimer(() => move("unlinked"), ms) : null;
    state = next;
    onChange({ state, attempt, at: now() });
  };
  return {
    state: () => state,
    attempt: () => attempt,
    // Only an unlinked worker takes a file offer; a live or recovering link is never replaced.
    begin: (next) => {
      if (state !== "unlinked") return false;
      attempt = next;
      move("connecting", CONNECT_MS);
      return true;
    },
    opened: (of) => {
      if (of === attempt && state !== "linked" && state !== "unlinked") move("linked");
    },
    closed: (of) => {
      if (of === attempt && state === "linked") move("recovering", RECOVER_MS);
    },
    lost: (of) => {
      if (of === attempt && state !== "unlinked") move("unlinked");
    },
  };
};
