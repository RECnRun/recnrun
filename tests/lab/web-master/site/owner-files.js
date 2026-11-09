// Folder I/O of the owner page: a NotFoundError means a missing file unless the root itself is gone.
const MARKER = "recnrun-workspace.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const rootGone = async (root) => {
  try {
    await root.values()[Symbol.asyncIterator]().next();
    return false;
  } catch (error) {
    return error?.name === "NotFoundError";
  }
};

const classify = async (root, error) => {
  if (error?.name === "NotAllowedError") return { status: "denied" };
  if (error?.name === "NotFoundError") {
    return { status: (await rootGone(root)) ? "folder-missing" : "missing" };
  }
  return { status: "error", message: String(error?.message ?? error) };
};

const locate = async (root, path, create) => {
  const parts = path.split("/");
  const name = parts.pop();
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name };
};

export const readFile = async (root, path) => {
  try {
    const { directory, name } = await locate(root, path, false);
    const file = await (await directory.getFileHandle(name)).getFile();
    return { status: "ok", bytes: new Uint8Array(await file.arrayBuffer()) };
  } catch (error) {
    return classify(root, error);
  }
};

export const writeFile = async (root, path, bytes) => {
  try {
    const { directory, name } = await locate(root, path, true);
    const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
    await writable.write(bytes);
    await writable.close();
    return { status: "ok" };
  } catch (error) {
    return classify(root, error);
  }
};

export const removeFile = async (root, path) => {
  try {
    const { directory, name } = await locate(root, path, false);
    await directory.removeEntry(name);
    return { status: "ok" };
  } catch (error) {
    return classify(root, error);
  }
};

const parseMarker = (bytes) => {
  try {
    const marker = JSON.parse(new TextDecoder().decode(bytes));
    const ok =
      marker?.v === 1 && typeof marker.workspaceId === "string" && UUID.test(marker.workspaceId);
    return ok ? { marker: "ok", workspaceId: marker.workspaceId } : { marker: "invalid" };
  } catch {
    return { marker: "invalid" };
  }
};

export const readMarker = async (root) => {
  const read = await readFile(root, MARKER);
  if (read.status === "ok") return parseMarker(read.bytes);
  if (read.status === "folder-missing") return { marker: "folder-missing" };
  return { marker: read.status === "missing" ? "missing" : "invalid" };
};

/** Gives a picked folder the marker launcher-request.sh reads; an existing valid one is kept. */
export const ensureMarker = async (root) => {
  const found = await readMarker(root);
  if (found.marker !== "missing" && found.marker !== "invalid") return found;
  const workspaceId = crypto.randomUUID();
  const text = JSON.stringify({ v: 1, workspaceId }, null, 1);
  const written = await writeFile(root, MARKER, new TextEncoder().encode(text));
  return written.status === "ok" ? { marker: "ok", workspaceId } : { marker: written.status };
};

// A dismissed picker is not an error: the caller keeps its current state.
export const pickFolder = async (picker) => {
  try {
    return await picker();
  } catch (error) {
    if (error?.name === "AbortError") return null;
    throw error;
  }
};
