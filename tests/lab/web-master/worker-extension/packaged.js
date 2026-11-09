// A file the launcher placed in the extension folder, as bytes, or null when it is absent.
export const readPackaged = async (name) => {
  try {
    const response = await fetch(chrome.runtime.getURL(name), { cache: "no-store" });
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    // An absent file, or a context with no extension URL, reads as absent.
    return null;
  }
};
