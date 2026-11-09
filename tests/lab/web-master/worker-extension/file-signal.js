// Owner flow: the launcher drops a signed offer under exchangeUrl; the answer leaves as a download.
import { isAttempt, offerFileOf, signAnswer } from "./offer-file.js";

export const POLL_MS = 1_000;

const pointerValid = (current) =>
  Boolean(current) && isAttempt(current.attempt) && current.file === offerFileOf(current.attempt);

/** One poll of current.json; each attempt is looked at once, answered at most once. */
export const createFileSignal = ({ exchangeUrl, context, deps }) => {
  const { readJson, check, link, connect, bootId, identity, emit, log } = deps;
  let seen = null;
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

/** A file:// read; absent or unparsable reads as null. */
export const readFileJson = async (url) => {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};
