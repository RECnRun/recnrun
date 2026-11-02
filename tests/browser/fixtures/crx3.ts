import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { crc32 } from "node:zlib";

/** A CRX3 package and the extension id Chrome derives from its key. */
export interface PackedExtension {
  id: string;
  crx: Buffer;
  version: string;
}

const CRX_MAGIC = "Cr24";
const CRX_VERSION = 3;
const SIGNATURE_CONTEXT = "CRX3 SignedData\x00";
// Field numbers from Chromium's components/crx_file/crx3.proto.
const CRX_FILE_HEADER_RSA = 2;
const CRX_FILE_HEADER_SIGNED_DATA = 10_000;
const ASYMMETRIC_KEY_PROOF_PUBLIC_KEY = 1;
const ASYMMETRIC_KEY_PROOF_SIGNATURE = 2;
const SIGNED_DATA_CRX_ID = 1;

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** A protobuf length-delimited field (wire type 2), the only kind CRX3 headers use. */
function field(number: number, value: Buffer): Buffer {
  return Buffer.concat([varint((number << 3) | 2), varint(value.length), value]);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function uint16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

/** Chrome's extension id: the first 128 bits of SHA-256 of a key or an unpacked path, hex digits mapped to a-p. */
export function extensionIdFrom(bytes: Buffer): string {
  const hex = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** A stored (uncompressed) ZIP archive; Chrome accepts method 0 entries. */
async function zipDirectory(directory: string): Promise<Buffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of await listFiles(directory)) {
    const name = Buffer.from(relative(directory, file).split(sep).join("/"));
    const data = await readFile(file);
    const shared = Buffer.concat([
      uint16(20), // version needed to extract
      uint16(0x0800), // flags: UTF-8 names
      uint16(0), // method: stored
      uint32(0), // DOS time and date
      uint32(crc32(data)),
      uint32(data.length),
      uint32(data.length),
      uint16(name.length),
      uint16(0), // extra length
    ]);
    const local = Buffer.concat([uint32(0x04034b50), shared, name, data]);
    const trailer = [uint16(0), uint16(0), uint16(0), uint32(0), uint32(offset)];
    centrals.push(Buffer.concat([uint32(0x02014b50), uint16(20), shared, ...trailer, name]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const count = uint16(centrals.length);
  const end = [uint32(0x06054b50), uint32(0), count, count, uint32(central.length)];
  return Buffer.concat([...locals, central, ...end, uint32(offset), uint16(0)]);
}

/** Packs an unpacked extension directory as a CRX3 signed with a fresh RSA key. */
export async function packCrx3(directory: string): Promise<PackedExtension> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const id = extensionIdFrom(publicKeyDer);
  const crxId = Buffer.from(createHash("sha256").update(publicKeyDer).digest().subarray(0, 16));
  const signedData = field(SIGNED_DATA_CRX_ID, crxId);
  const archive = await zipDirectory(directory);
  const signer = createSign("sha256");
  signer.update(Buffer.from(SIGNATURE_CONTEXT, "binary"));
  signer.update(uint32(signedData.length));
  signer.update(signedData);
  signer.update(archive);
  const proof = Buffer.concat([
    field(ASYMMETRIC_KEY_PROOF_PUBLIC_KEY, publicKeyDer),
    field(ASYMMETRIC_KEY_PROOF_SIGNATURE, signer.sign(privateKey)),
  ]);
  const header = Buffer.concat([
    field(CRX_FILE_HEADER_RSA, proof),
    field(CRX_FILE_HEADER_SIGNED_DATA, signedData),
  ]);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
    version: string;
  };
  const prefix = Buffer.concat([
    Buffer.from(CRX_MAGIC),
    uint32(CRX_VERSION),
    uint32(header.length),
  ]);
  return { id, crx: Buffer.concat([prefix, header, archive]), version: manifest.version };
}
