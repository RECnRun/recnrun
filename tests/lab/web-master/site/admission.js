// W6 review: the master shows frames only of a session the worker accepted, until it lapses.
const LEASE_MS = 3_000;
const GRANT_MS = 600_000;

const plain = (uuid) => String(uuid).replaceAll("-", "");

export const createAdmission = ({
  now = Date.now,
  leaseMs = LEASE_MS,
  grantMs = GRANT_MS,
} = {}) => {
  const sessions = new Map();
  const revoked = {};

  /** Asked for, not yet accepted: the latest complete frame is held, never shown. */
  const request = (name, session) => {
    sessions.set(name, { ...session, state: "PENDING", held: null, acceptedAt: 0, renewedAt: 0 });
  };

  const revoke = (name, reason) => {
    if (!sessions.delete(name)) return;
    revoked[reason] = (revoked[reason] ?? 0) + 1;
  };

  const lapsed = (session) => {
    if (session.state !== "ACCEPTED") return false;
    return now() > session.renewedAt + leaseMs || now() > session.acceptedAt + grantMs;
  };

  /** The reason a frame header is refused on link `name`, or null. */
  const check = (name, head) => {
    const session = sessions.get(name);
    if (!session) return "unsolicited";
    if (head.bootId !== plain(session.bootId)) return "wrong-boot";
    if (head.jobId !== plain(session.jobId)) return "wrong-job";
    if (head.targetId !== session.targetId) return "wrong-target";
    if (head.sessionEpoch !== session.sessionEpoch) return "wrong-session";
    if (!lapsed(session)) return null;
    revoke(name, "lapsed");
    return "lapsed";
  };

  /** A complete frame: shown in an accepted session, held while the start is pending. */
  const offer = (name, frame, show) => {
    if (check(name, frame)) return false;
    const session = sessions.get(name);
    if (session.state === "PENDING") {
      session.held = frame;
      return false;
    }
    show(frame);
    return true;
  };

  /** The worker accepted the start: a frame that beat the reply is shown now. */
  const accept = (name, show) => {
    const session = sessions.get(name);
    if (session?.state !== "PENDING") return;
    Object.assign(session, { state: "ACCEPTED", acceptedAt: now(), renewedAt: now() });
    const { held } = session;
    session.held = null;
    if (held) offer(name, held, show);
  };

  const renewed = (name) => {
    const session = sessions.get(name);
    if (session?.state === "ACCEPTED") session.renewedAt = now();
  };

  return {
    request,
    accept,
    renewed,
    revoke,
    check,
    offer,
    session: (name) => sessions.get(name),
    stats: () => ({ revoked: { ...revoked } }),
  };
};
