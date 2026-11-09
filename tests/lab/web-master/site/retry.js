// Start retry: only the previous lease still landing is waited out; any other refusal is shown as it is.
export const RETRYABLE = ["CLAIMED", "ACTIVE", "CLEANUP"];
const DELAYS = [250, 500, 1000, 2000];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const retrying = async (attempt, { delays = DELAYS, sleep = wait } = {}) => {
  let reply = await attempt();
  let real = null;
  for (const delay of delays) {
    if (reply.ok || !RETRYABLE.includes(reply.code)) break;
    real = reply;
    await sleep(delay);
    reply = await attempt();
  }
  // A RATE_LIMITED that the retries themselves caused must not hide the refusal that came first.
  return real && reply.code === "RATE_LIMITED" ? real : reply;
};
