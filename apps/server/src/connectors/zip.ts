import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createInflateRaw, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  /** Offset of the entry's compressed data in the archive. */
  dataOffset: number;
  compressedSize: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** Entries of an in-memory zip archive (no Zip64, no encryption: enough for GTFS feeds). */
export function zipEntries(zip: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== CENTRAL) throw new Error('Corrupt zip directory');
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLength);
    if (compressedSize === 0xffffffff || local === 0xffffffff)
      throw new Error('Zip64 not supported');
    if (zip.readUInt32LE(local) !== LOCAL) throw new Error('Corrupt zip entry');
    const dataOffset = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (dataOffset + compressedSize > zip.length) throw new Error('Truncated zip entry');
    entries.set(name, { name, method, dataOffset, compressedSize });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function data(zip: Buffer, entry: ZipEntry): Buffer {
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new Error(`Unsupported zip method ${entry.method}`);
  }
  return zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
}

/** A small entry, decompressed in one go. */
export function readEntry(zip: Buffer, entry: ZipEntry): string {
  const raw = data(zip, entry);
  return (entry.method === STORED ? raw : inflateRawSync(raw)).toString('utf8');
}

/** The lines of a (possibly very large) entry, decompressed as a stream. */
export function entryLines(zip: Buffer, entry: ZipEntry): AsyncIterable<string> {
  const raw = Readable.from([data(zip, entry)]);
  const text = entry.method === STORED ? raw : raw.pipe(createInflateRaw());
  return createInterface({ input: text, crlfDelay: Infinity });
}
