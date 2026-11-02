import { join } from "node:path";
import { isId, type Flow } from "@recnrun/protocol";
import { writeOnce } from "./atomic-file.ts";
import { canonicalJson, sha256 } from "./canonical.ts";
import { checkFlow } from "./flow-yaml.ts";
import { FlowStoreError, parseJsonText, readText } from "./store-files.ts";

/** The revision a flow has: the sha256 of its canonical JSON. */
export const revisionOf = (flow: Flow): string => sha256(canonicalJson(flow));

const revisionPath = (folder: string, revision: string) =>
  join(folder, "revisions", `${revision}.json`);

/** Writes the flow's canonical JSON as revisions/<hash>.json; an existing revision never changes. */
export async function writeRevision(folder: string, flow: Flow): Promise<string> {
  const text = canonicalJson(flow);
  const revision = sha256(text);
  const path = revisionPath(folder, revision);
  if (!(await writeOnce(path, text))) {
    throw new FlowStoreError(
      "revision-conflict",
      path,
      "a revision with this hash already holds different content, and revisions are immutable",
    );
  }
  return revision;
}

/** Reads a revision back, checking that its bytes still hash to its name. */
export async function readRevision(folder: string, revision: string): Promise<Flow> {
  // A hex digest is also a safe file name; anything else never reaches the file system.
  if (!isId(revision)) throw new FlowStoreError("not-found", revision, "not a revision hash");
  const path = revisionPath(folder, revision);
  const text = await readText(path);
  if (sha256(text) !== revision) {
    throw new FlowStoreError("revision-mismatch", path, "its content no longer hashes to its name");
  }
  return checkFlow(path, parseJsonText(path, text));
}
