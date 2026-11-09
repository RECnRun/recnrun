// Owner flow: the launcher drops a signed offer under exchangeUrl; the answer leaves as a download.
import { isAttempt, offerFileOf, signAnswer } from "./offer-file.js";

export const POLL_MS = 1_000;

const pointerValid = (current) =>
  Boolean(current) && isAttempt(current.attempt) && current.file === offerFileOf(current.attempt);

/** One poll of current.json; each attempt is looked at once, answered at most once. */
export const createFileSignal = ({ exchangeUrl, context, deps }) => {
  const { readJson, check, link, connect, bootId, identity, emit, log } = deps;
  let seen = null;
  let waiting = null;
  const answer = async (offer) => {
    if (!link.begin(offer.attempt)) return;
    try {
      const sdp = await connect(offer.sdp, offer.attempt);
      const body = await signAnswer({
        offer,
        bootId: await bootId(),
        sdp,
        identity: await identity,
      });
      await emit(`answer-${offer.attempt}.json`, body);
    } catch (error) {
      link.lost(offer.attempt);
      log(`offer failed: ${String(error)}`);
    }
  };
  const tick = async () => {
    const current = await readJson(`${exchangeUrl}current.json`);
    if (!pointerValid(current) || current.attempt === seen) return;
    // A closed link holds its slot until it times out; the offer waiting for it is kept.
    if (link.state() === "recovering") {
      if (waiting !== current.attempt) log("offer waits: recovering");
      waiting = current.attempt;
      return;
    }
    seen = current.attempt;
    // A live link is never replaced from a file; the launcher sees state.json and reports BUSY.
    if (link.state() !== "unlinked") return log("offer ignored: linked");
    const offer = await readJson(`${exchangeUrl}${current.file}`);
    const refused = offer?.attempt === current.attempt ? await check(offer, context) : "BAD_FORMAT";
    if (refused) return log(`offer refused: ${refused}`);
    await answer(offer);
  };
  return { tick };
};

/** The worker proves it cannot read local files; /etc/hosts exists on macOS and Linux. */
export const canReadFiles = async () => {
  try {
    return (await fetch("file:///etc/hosts", { cache: "no-store" })).ok;
  } catch {
    return false;
  }
};

/** A read of the extension's own exchange folder; absent or unparsable reads as null. */
export const readFileJson = async (url) => {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};
