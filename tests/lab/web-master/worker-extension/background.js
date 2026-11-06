// The harness calls globalThis.lab through CDP; the offscreen document holds the link.
const ensureOffscreen = async () => {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WEB_RTC"],
    justification: "Answers the master page's WebRTC offer.",
  });
};

const ask = async (message) => {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", ...message });
};

globalThis.lab = {
  identity: () => ask({ type: "identity" }),
  answer: (offer) => ask({ type: "answer", offer }),
};
