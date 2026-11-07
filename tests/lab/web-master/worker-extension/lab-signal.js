// LAB-ONLY (W6.16): polls the harness's loopback relay for offers when no CDP client can relay them.
const POLL_MS = 250;
const METRICS_MS = 1_000;
let started = false;

const post = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(body),
  });

const pollOnce = async (base, answer, identity) => {
  const response = await fetch(`${base}/offer`);
  if (response.status !== 200) return;
  const sdp = await answer(await response.text());
  await post(`${base}/answer`, { answer: sdp, identity: await identity() });
};

/** Starts the poll and the metrics posts once per offscreen document. */
export const startLabSignal = (base, { answer, identity, metrics }) => {
  if (started) return;
  started = true;
  const loop = async () => {
    await pollOnce(base, answer, identity).catch(() => undefined);
    setTimeout(() => void loop(), POLL_MS);
  };
  void loop();
  setInterval(() => {
    post(`${base}/metrics`, metrics()).catch(() => undefined);
  }, METRICS_MS);
};
