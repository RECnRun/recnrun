import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BINDINGS_SCHEMA_VERSION,
  parseBindingsFile,
  type BindingsFile,
  type ProfileBinding,
} from "@recnrun/protocol";

/** The local bindings of this user, in `<home>/.recnrun/bindings.json`; never in a flow folder. */
export interface BindingsStore {
  readonly path: string;
  /** Every binding; an absent file is an empty list. */
  list(): Promise<ProfileBinding[]>;
  /** Adds the binding, or replaces the one with the same name. */
  save(binding: ProfileBinding): Promise<void>;
  /** Removes the binding with this name; false when there was none. */
  remove(name: string): Promise<boolean>;
}

/** The bindings file exists but cannot be read as one; it is left untouched for the user. */
export class BindingsFileError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(
      `${path} is not a valid bindings file: ${detail}. Fix or move it; RECnRun will not overwrite it.`,
    );
    this.name = "BindingsFileError";
    this.path = path;
  }
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

async function readBindings(path: string): Promise<ProfileBinding[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new BindingsFileError(
      path,
      `not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const parsed = parseBindingsFile(json);
  if (!parsed.ok) throw new BindingsFileError(path, parsed.message);
  return parsed.file.bindings;
}

// Written beside the target and renamed over it, so a crash leaves the old file or the new one.
async function writeBindings(path: string, bindings: ProfileBinding[]): Promise<void> {
  const file: BindingsFile = { schemaVersion: BINDINGS_SCHEMA_VERSION, bindings };
  const parsed = parseBindingsFile(file);
  if (!parsed.ok) throw new Error(`Refusing to write an invalid bindings file: ${parsed.message}`);
  const folder = dirname(path);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const temporary = join(folder, `.bindings.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(parsed.file, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Opens the bindings store of the user whose home folder is `home`. */
export function openBindingsStore({ home }: { home: string }): BindingsStore {
  const path = join(home, ".recnrun", "bindings.json");
  // One chain per store, so each read-modify-write sees the previous one's result.
  let turn: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = turn.then(work);
    turn = result.catch(() => undefined);
    return result;
  };
  return {
    path,
    list: () => readBindings(path),
    save: (binding) =>
      exclusive(async () => {
        const bindings = await readBindings(path);
        const index = bindings.findIndex(({ name }) => name === binding.name);
        if (index === -1) bindings.push(binding);
        else bindings[index] = binding;
        await writeBindings(path, bindings);
      }),
    remove: (name) =>
      exclusive(async () => {
        const bindings = await readBindings(path);
        const kept = bindings.filter((binding) => binding.name !== name);
        if (kept.length === bindings.length) return false;
        await writeBindings(path, kept);
        return true;
      }),
  };
}
