import { gunzipSync } from "node:zlib";
import { posix } from "node:path";

import { ControlError } from "../foundation/contracts";

const BLOCK = 512;
const MAX_COMPRESSED = 5 * 1024 * 1024;
const MAX_EXPANDED = 20 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FILES = 256;

function field(block: Uint8Array, offset: number, length: number): string {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  const selected = end < 0 ? bytes : bytes.subarray(0, end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(selected);
  } catch {
    throw new ControlError("PACK_TAR_HEADER_UTF8_REFUSED", 422);
  }
}

function octal(block: Uint8Array, offset: number, length: number, code: string): number {
  const raw = field(block, offset, length).trim();
  if (!/^[0-7]+$/u.test(raw)) throw new ControlError(code, 422);
  const result = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(result) || result < 0) throw new ControlError(code, 422);
  return result;
}

function checksum(block: Uint8Array): number {
  return block.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
}

function safePath(value: string): string {
  if (
    value.length < 1 || value.length > 240 || value.startsWith("/") || value.includes("\\") ||
    posix.normalize(value) !== value
  ) {
    throw new ControlError("PACK_ARCHIVE_PATH_REFUSED", 422);
  }
  const segments = value.split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new ControlError("PACK_ARCHIVE_PATH_REFUSED", 422);
  }
  return value;
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

export function readBoundedTarGzip(archive: Uint8Array): ReadonlyMap<string, Uint8Array> {
  if (archive.byteLength < 1 || archive.byteLength > MAX_COMPRESSED) {
    throw new ControlError("PACK_ARCHIVE_COMPRESSED_SIZE_REFUSED", 422);
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED });
  } catch {
    throw new ControlError("PACK_ARCHIVE_GZIP_REFUSED", 422);
  }
  if (tar.byteLength < BLOCK * 2 || tar.byteLength > MAX_EXPANDED || tar.byteLength % BLOCK !== 0) {
    throw new ControlError("PACK_ARCHIVE_EXPANDED_SIZE_REFUSED", 422);
  }

  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let ended = false;
  while (offset < tar.byteLength) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (allZero(header)) {
      if (offset + BLOCK * 2 > tar.byteLength || !allZero(tar.subarray(offset))) {
        throw new ControlError("PACK_ARCHIVE_TRAILING_CONTENT_REFUSED", 422);
      }
      ended = true;
      break;
    }
    if (header.byteLength !== BLOCK) throw new ControlError("PACK_TAR_HEADER_REFUSED", 422);
    const expectedChecksum = octal(header, 148, 8, "PACK_TAR_CHECKSUM_REFUSED");
    if (checksum(header) !== expectedChecksum) throw new ControlError("PACK_TAR_CHECKSUM_REFUSED", 422);
    const type = header[156];
    if (type !== 0 && type !== 48) throw new ControlError("PACK_ARCHIVE_FILE_TYPE_REFUSED", 422);
    const mode = octal(header, 100, 8, "PACK_TAR_MODE_REFUSED");
    if ((mode & 0o111) !== 0) throw new ControlError("PACK_ARCHIVE_EXECUTABLE_REFUSED", 422);
    const size = octal(header, 124, 12, "PACK_TAR_SIZE_REFUSED");
    if (size > MAX_FILE) throw new ControlError("PACK_ARCHIVE_FILE_SIZE_REFUSED", 422);
    const prefix = field(header, 345, 155);
    const name = safePath([prefix, field(header, 0, 100)].filter(Boolean).join("/"));
    if (files.has(name)) throw new ControlError("PACK_ARCHIVE_DUPLICATE_PATH", 422);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) throw new ControlError("PACK_ARCHIVE_TRUNCATED", 422);
    const content = tar.subarray(dataStart, dataEnd);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new ControlError("PACK_ARCHIVE_FILE_UTF8_REFUSED", 422);
    }
    files.set(name, Uint8Array.from(content));
    if (files.size > MAX_FILES) throw new ControlError("PACK_ARCHIVE_FILE_COUNT_REFUSED", 422);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!ended || files.size === 0) throw new ControlError("PACK_ARCHIVE_TERMINATOR_REFUSED", 422);
  return files;
}
