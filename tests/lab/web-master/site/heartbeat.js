// The launcher's heartbeat (unsigned key=value lines): parsing, and staleness judged by this page.
const HEADER = "recnrun-lab-heartbeat v1";
const STATES = ["idle", "pairing", "installing", "launching", "delivering", "stopping"];
const STALE_SEQ_MS = 6_000;
const PAST_S = 6;
const FUTURE_S = 5;
const NUMBERS = ["seq", "at"];

export const parseHeartbeat = (text) => {
  const [header, ...lines] = text.split("\n");
  if (header !== HEADER) return null;
  const fields = Object.fromEntries(
    lines.filter((line) => line.includes("=")).map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  for (const key of ["session", "state", "paired", "launcher", "extension", ...NUMBERS])
    if (typeof fields[key] !== "string") return null;
  for (const key of NUMBERS) {
    if (!/^\d+$/.test(fields[key])) return null;
    fields[key] = Number(fields[key]);
  }
  const pairedOk =
    ["none", "rejected"].includes(fields.paired) || /^[0-9a-f]{64}$/.test(fields.paired);
  return STATES.includes(fields.state) && pairedOk ? fields : null;
};

const STATUS_STATES = ["verifying", "installing", "launching", "delivering", "answered", "refused"];
const CODES = [
  "BAD_FORMAT",
  "BAD_SIGNATURE",
  "EXPIRED",
  "REPLAY",
  "NOT_PAIRED",
  "BUSY",
  "INSTALL_FAILED",
  "LAUNCH_FAILED",
  "NO_ANSWER",
  "LAUNCHER_RESTARTED",
];

/** A request's status file (unsigned); a code outside the known list makes the file invalid. */
export const parseStatus = (text) => {
  const [header, ...lines] = text.split("\n");
  if (header !== "recnrun-lab-status v1") return null;
  const fields = Object.fromEntries(
    lines.filter((line) => line.includes("=")).map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  if (!STATUS_STATES.includes(fields.state)) return null;
  if (fields.code !== undefined && !CODES.includes(fields.code)) return null;
  return fields;
};

const skewed = (heartbeat, now) =>
  heartbeat.at < now / 1000 - PAST_S || heartbeat.at > now / 1000 + FUTURE_S;

// Whether another launcher session replaced the one seen before; sticky until the page resets it.
const changedSession = (previous, heartbeat) =>
  Boolean(previous?.sessionChanged) ||
  Boolean(previous?.session && heartbeat && heartbeat.session !== previous.session);

const seqSince = (previous, heartbeat, now) =>
  previous && previous.seq === heartbeat.seq ? previous.seqChangedAt : now;

/** The next tracker: `text` is the heartbeat file's text, or null when it is missing. */
export const track = (previous, text, now) => {
  const heartbeat = text === null ? null : parseHeartbeat(text);
  const session = heartbeat?.session ?? previous?.session ?? null;
  const sessionChanged = changedSession(previous, heartbeat);
  if (!heartbeat)
    return { heartbeat, session, seq: null, seqChangedAt: now, stale: true, sessionChanged };
  const seqChangedAt = seqSince(previous, heartbeat, now);
  const stale = skewed(heartbeat, now) || now - seqChangedAt > STALE_SEQ_MS;
  return { heartbeat, session, seq: heartbeat.seq, seqChangedAt, stale, sessionChanged };
};
