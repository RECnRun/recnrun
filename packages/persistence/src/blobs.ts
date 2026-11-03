import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_MAX_BLOB_BYTES,
  isSha256,
  type BodyEncoding,
  type BodyRef,
} from "@recnrun/protocol";
import { hasCode, writeOnce } from "./atomic-file.ts";

export type BlobStoreErrorCode = "invalid-name" | "not-found" | "corrupt";

/** A blob that cannot be named, found, or trusted; the message names the file, never its bytes. */
export class BlobStoreError extends Error {
  override readonly name = "BlobStoreError";
  readonly code: BlobStoreErrorCode;
  readonly path: string;

  constructor(code: BlobStoreErrorCode, path: string, detail: string) {
    super(`${detail}: ${path}`);
    this.code = code;
    this.path = path;
  }
}

export interface BlobMeta {
  mime: string;
  encoding: BodyEncoding;
  /** This body's cap, in place of the store's; snapshots and screenshots have their own. */
  maxBytes?: number | undefined;
}

/** Content-addressed bodies of one session or run: each file is named by the sha256 of its bytes. */
export interface BlobStore {
  readonly folder: string;
  /** Bodies longer than this keep their first `maxBytes` bytes and are `truncated`. */
  readonly maxBytes: number;
  /** A string is stored as its UTF-8 bytes, which the cap and `size` count. */
  put(content: Uint8Array | string, meta: BlobMeta): Promise<BodyRef>;
  read(sha256: string): Promise<Buffer>;
}

export interface BlobStoreOptions {
  folder: string;
  maxBytes?: number;
}

const corrupt = (path: string) =>
  new BlobStoreError("corrupt", path, "A blob file does not hold the bytes it is named by");

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Reads a blob of `folder` without creating the folder; the bytes must match their name. */
export async function readBlob(folder: string, sha256: string): Promise<Buffer> {
  if (!isSha256(sha256))
    throw new BlobStoreError("invalid-name", sha256, "A blob is named by a lowercase sha256");
  const path = join(folder, sha256);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new BlobStoreError("not-found", path, "No such blob");
    throw error;
  }
  if (digest(bytes) !== sha256) throw corrupt(path);
  return bytes;
}

/** Opens the blob folder (mode 0700, created when missing); blob files are written at mode 0600. */
export async function openBlobStore(options: BlobStoreOptions): Promise<BlobStore> {
  const { folder, maxBytes = DEFAULT_MAX_BLOB_BYTES } = options;
  if (!Number.isInteger(maxBytes) || maxBytes < 1)
    throw new RangeError(`The blob cap must be a positive integer, not ${maxBytes}.`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);

  const put = async (content: Uint8Array | string, meta: BlobMeta): Promise<BodyRef> => {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const cap = meta.maxBytes ?? maxBytes;
    // The cap applies before hashing and writing, so nothing past it ever reaches the disk.
    const kept = bytes.length > cap ? bytes.subarray(0, cap) : bytes;
    const sha256 = digest(kept);
    const path = join(folder, sha256);
    if (!(await writeOnce(path, kept, 0o600))) throw corrupt(path);
    const condition = kept === bytes ? "captured" : "truncated";
    return { sha256, mime: meta.mime, encoding: meta.encoding, size: bytes.length, condition };
  };

  return { folder, maxBytes, put, read: (sha256) => readBlob(folder, sha256) };
}
