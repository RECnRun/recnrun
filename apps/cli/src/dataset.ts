import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Dataset, isId, parseStored } from "@recnrun/protocol";

/** The folder `--flow` names: the folder itself, or the one holding a flow file. */
async function folderOf(flowPath: string): Promise<string> {
  const isFolder = await stat(flowPath).then(
    (found) => found.isDirectory(),
    () => false,
  );
  return isFolder ? flowPath : dirname(flowPath);
}

/** Reads and validates `datasets/<name>.json` next to the flow that `--flow` names. */
export async function loadDataset(flowPath: string, name: string): Promise<Dataset> {
  if (!isId(name))
    throw new Error(`${JSON.stringify(name)}: a dataset name is a slug such as "default".`);
  const file = join(await folderOf(flowPath), "datasets", `${name}.json`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "is not JSON" : "cannot be read";
    throw new Error(`${file}: the dataset ${reason}.`);
  }
  const parsed = parseStored("dataset", value);
  if (!parsed.ok) throw new Error(`${file}: not a valid dataset (${parsed.message}).`);
  return parsed.value;
}
