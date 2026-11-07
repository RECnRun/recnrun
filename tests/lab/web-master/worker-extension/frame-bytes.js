// Base64 JPEG to bytes, timed, with the image size read from its start-of-frame marker.
const SOF = new Set([0xc0, 0xc1, 0xc2]);

/** Width and height from the first SOF0–SOF2 segment, or zeros when there is none. */
const jpegSize = (bytes) => {
  let at = 2;
  while (at + 9 < bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    if (SOF.has(marker)) {
      return {
        height: (bytes[at + 5] << 8) | bytes[at + 6],
        width: (bytes[at + 7] << 8) | bytes[at + 8],
      };
    }
    at += 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
  }
  return { width: 0, height: 0 };
};

export const decodeFrame = (data) => {
  const started = performance.now();
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  const decodeMs = performance.now() - started;
  return { bytes, decodeMs, ...jpegSize(bytes) };
};
