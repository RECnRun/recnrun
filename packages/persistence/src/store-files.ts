import { readFile } from "node:fs/promises";
import {
  parseStored,
  type FlowStoreErrorCode,
  type Stored,
  type StoredShape,
  type StoreProblem,
} from "@recnrun/protocol";
import { hasCode, writeAtomic } from "./atomic-file.ts";

/** A file of the flow store that is missing, unreadable, or not what it should hold. */
export class FlowStoreError extends Error {
  readonly code: FlowStoreErrorCode;
  readonly path: string;
  constructor(code: FlowStoreErrorCode, path: string, detail: string) {
    super(`${path}: ${detail}.`);
    this.name = "FlowStoreError";
    this.code = code;
    this.path = path;
  }

  /** The error as a listing reports it. */
  toProblem(): StoreProblem {
    return { path: this.path, code: this.code, message: this.message };
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads a text file; a missing or unreadable file is a FlowStoreError. */
export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new FlowStoreError("not-found", path, "no such file");
    throw new FlowStoreError("unreadable", path, describe(error));
  }
}

/** Parses JSON text; text that is not JSON is a FlowStoreError. */
export function parseJsonText(path: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new FlowStoreError("not-json", path, `not JSON (${describe(error)})`);
  }
}

/** Validates a value with its protocol shape; one that does not match is a FlowStoreError. */
export function checkStored<K extends StoredShape>(
  shape: K,
  path: string,
  value: unknown,
): Stored<K> {
  const parsed = parseStored(shape, value);
  if (!parsed.ok) {
    throw new FlowStoreError("invalid", path, `not a valid ${shape} (${parsed.message})`);
  }
  return parsed.value;
}

/** Reads and validates a JSON file of the store. */
export async function readStored<K extends StoredShape>(
  shape: K,
  path: string,
): Promise<Stored<K>> {
  return checkStored(shape, path, parseJsonText(path, await readText(path)));
}

/** Like readStored, but a missing file is undefined. */
export async function readStoredIfPresent<K extends StoredShape>(
  shape: K,
  path: string,
): Promise<Stored<K> | undefined> {
  try {
    return await readStored(shape, path);
  } catch (error) {
    if (error instanceof FlowStoreError && error.code === "not-found") return undefined;
    throw error;
  }
}

/** Validates and writes a JSON file of the store atomically, formatted for people to read. */
export async function writeStored<K extends StoredShape>(
  shape: K,
  path: string,
  value: unknown,
): Promise<Stored<K>> {
  const checked = checkStored(shape, path, value);
  await writeAtomic(path, `${JSON.stringify(checked, null, 2)}\n`);
  return checked;
}
