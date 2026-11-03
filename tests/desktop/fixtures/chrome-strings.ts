// Chrome's own words: the strings of its locale resource pack, where every dialog's text lives.
import { readFile } from "node:fs/promises";

const LOCALE_PAK = "/opt/google/chrome/locales/en-US.pak";
const HEADER_BYTES = 12;
const ENTRY_BYTES = 6;

/** Every resource of a version 5 pak file whose text matches, in file order. */
export async function chromeStrings(pattern: RegExp, file = LOCALE_PAK): Promise<string[]> {
  const pak = await readFile(file);
  const version = pak.readUInt32LE(0);
  if (version !== 5) throw new Error(`${file} is a version ${version} pak; only 5 is read.`);
  const count = pak.readUInt16LE(8);
  const offsetOf = (index: number) => pak.readUInt32LE(HEADER_BYTES + index * ENTRY_BYTES + 2);
  const strings: string[] = [];
  // The table has one entry past the last resource, whose offset is that resource's end.
  for (let index = 0; index < count; index++) {
    const text = pak.toString("utf8", offsetOf(index), offsetOf(index + 1));
    if (pattern.test(text)) strings.push(text);
  }
  return strings;
}
