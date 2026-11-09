import { describe, expect, test } from "vite-plus/test";
import { awaitAnswer } from "./site/owner-launch.js";
import type { FolderHandle } from "./site/owner-files.js";

/* The owner page's wait for the launcher: it reads the status file the launcher publishes. */

const missing = () => new DOMException("NotFoundError", "NotFoundError");

// A read-only folder over a flat map of paths, enough for readFile.
const folder = (files: Map<string, string>, prefix = ""): FolderHandle =>
  ({
    getDirectoryHandle: async (name: string) => folder(files, `${prefix}${name}/`),
    getFileHandle: async (name: string) => {
      const path = `${prefix}${name}`;
      if (!files.has(path)) throw missing();
      const bytes = new TextEncoder().encode(files.get(path));
      return { getFile: async () => ({ arrayBuffer: async () => bytes.buffer }) };
    },
    values: () => ({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    }),
  }) as unknown as FolderHandle;

const RID = "6c0d1f6e-3b0a-4a51-9a0e-1d2c3b4a5f60";
const ATTEMPT = "0f1e2d3c-4b5a-4968-8776-655443322110";
const refused = (code: string) =>
  `recnrun-lab-status v1\nrequest=${RID}\nsession=0123456789abcdef\nstate=refused\ncode=${code}\nat=1\nseq=2\n`;

describe("awaitAnswer", () => {
  test("a refusal in status/<rid>.status ends the wait with its code", async () => {
    // launcher-request.sh publish_status writes workspace/status/<rid>.status.
    const files = new Map([[`status/${RID}.status`, refused("BUSY")]]);
    const said: string[] = [];
    const context = { root: folder(files), say: (text: string) => said.push(text), waitMs: 300 };
    const waited = await awaitAnswer(context, { attempt: ATTEMPT, request: RID });
    expect(waited).toEqual({ ok: false, code: "BUSY" });
  });

  test("the copied answer ends the wait", async () => {
    const answer = { type: "answer", attempt: ATTEMPT };
    const files = new Map([[`exchange/w1/answer-${ATTEMPT}.json`, JSON.stringify(answer)]]);
    const context = { root: folder(files), say: () => undefined, waitMs: 300 };
    expect(await awaitAnswer(context, { attempt: ATTEMPT, request: RID })).toEqual({
      ok: true,
      answer,
    });
  });
});
