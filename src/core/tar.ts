import { gunzipSync } from "node:zlib";

/** One regular file of an archive: its path as the archive names it, its mode and its bytes. */
export interface TarFile {
  path: string;
  mode: number;
  content: Uint8Array;
}

/** The archive read: its regular files in order, and the directories it names. */
export interface TarArchive {
  files: TarFile[];
  directories: string[];
}

/** Why an archive could not be read, as a sentence; the caller decides what it means. */
export class TarError extends Error {
  override readonly name = "TarError";
}

const BLOCK = 512;

/** The most an archive may unpack to: a proposed setup is a handful of small scripts. */
export const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;

/**
 * Reads a gzip-compressed tar archive (ustar, with pax and GNU long names) into its regular files
 * and directories, writing nothing. Any other entry (a link, a device, a FIFO) is a `TarError`, as
 * are a body that is not gzip, a header whose checksum does not match, an archive cut short, and
 * one that unpacks to more than `MAX_UNPACKED_BYTES`.
 */
export function readTarGz(bytes: Uint8Array): TarArchive {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (error) {
    throw new TarError(
      `It is not a gzip-compressed archive (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const files: TarFile[] = [];
  const directories: string[] = [];
  let longName: string | undefined;
  let paxPath: string | undefined;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return { files, directories };
    checkSum(header, offset);
    const size = octal(header, 124, 12, "size");
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + BLOCK;
    const end = start + size;
    if (end > tar.length) throw new TarError("The archive is cut short.");
    const body = tar.subarray(start, end);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") {
      longName = text(body, 0, body.length);
      continue;
    }
    if (type === "x") {
      paxPath = paxValue(body, "path") ?? paxPath;
      continue;
    }
    if (type === "g") continue;
    const prefix = text(header, 345, 155);
    const name = text(header, 0, 100);
    const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;
    paxPath = undefined;
    if (type === "0" || type === "\0" || type === "7") {
      files.push({ path, mode: octal(header, 100, 8, "mode"), content: new Uint8Array(body) });
    } else if (type === "5") {
      directories.push(path);
    } else {
      throw new TarError(`${JSON.stringify(path)} is not a regular file or a directory.`);
    }
  }
  throw new TarError("The archive has no end-of-archive marker.");
}

function checkSum(header: Buffer, offset: number): void {
  const stated = octal(header, 148, 8, "checksum");
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (sum !== stated) throw new TarError(`The header at byte ${offset} is damaged.`);
}

function octal(header: Buffer, start: number, length: number, field: string): number {
  const value = text(header, start, length).trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/.test(value)) throw new TarError(`A header's ${field} is not a number.`);
  return parseInt(value, 8);
}

function text(buffer: Buffer, start: number, length: number): string {
  const field = buffer.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

/** One record of a pax extended header (`<length> <key>=<value>\n` records). */
function paxValue(body: Buffer, key: string): string | undefined {
  let found: string | undefined;
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(body.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isInteger(length) || length <= 0) break;
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === key) found = record.slice(equals + 1);
    offset += length;
  }
  return found;
}
