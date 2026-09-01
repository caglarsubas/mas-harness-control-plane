import { createHash } from "node:crypto";

export class CanonicalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CanonicalError";
  }
}

class JsonReader {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value();
    this.space();
    if (this.offset !== this.source.length) throw new CanonicalError("JSON_TRAILING_DATA");
    return value;
  }

  private space(): void {
    while (/\s/u.test(this.source[this.offset] ?? "")) this.offset += 1;
  }

  private value(): unknown {
    this.space();
    const char = this.source[this.offset];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    if (char === "t" && this.take("true")) return true;
    if (char === "f" && this.take("false")) return false;
    if (char === "n" && this.take("null")) return null;
    return this.number();
  }

  private take(literal: string): boolean {
    if (!this.source.startsWith(literal, this.offset)) return false;
    this.offset += literal.length;
    return true;
  }

  private string(): string {
    const start = this.offset++;
    let escaped = false;
    for (; this.offset < this.source.length; this.offset += 1) {
      const char = this.source[this.offset];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        this.offset += 1;
        try {
          return JSON.parse(this.source.slice(start, this.offset)) as string;
        } catch {
          throw new CanonicalError("JSON_STRING_INVALID");
        }
      } else if ((char?.charCodeAt(0) ?? 32) < 32) {
        throw new CanonicalError("JSON_STRING_INVALID");
      }
    }
    throw new CanonicalError("JSON_STRING_UNTERMINATED");
  }

  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.source.slice(this.offset));
    if (!match) throw new CanonicalError("JSON_VALUE_INVALID");
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new CanonicalError("JSON_NUMBER_INVALID");
    return value;
  }

  private array(): unknown[] {
    this.offset += 1;
    const values: unknown[] = [];
    this.space();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return values;
    }
    while (true) {
      values.push(this.value());
      this.space();
      const char = this.source[this.offset++];
      if (char === "]") return values;
      if (char !== ",") throw new CanonicalError("JSON_ARRAY_INVALID");
    }
  }

  private object(): Record<string, unknown> {
    this.offset += 1;
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.space();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return result;
    }
    while (true) {
      this.space();
      if (this.source[this.offset] !== '"') throw new CanonicalError("JSON_OBJECT_KEY_INVALID");
      const key = this.string();
      if (keys.has(key)) throw new CanonicalError("JSON_DUPLICATE_MEMBER");
      keys.add(key);
      this.space();
      if (this.source[this.offset++] !== ":") throw new CanonicalError("JSON_OBJECT_INVALID");
      result[key] = this.value();
      this.space();
      const char = this.source[this.offset++];
      if (char === "}") return result;
      if (char !== ",") throw new CanonicalError("JSON_OBJECT_INVALID");
    }
  }
}

export function parseJsonNoDuplicates(source: string, maxBytes = 65_536): unknown {
  if (Buffer.byteLength(source, "utf8") > maxBytes) throw new CanonicalError("JSON_TOO_LARGE");
  return new JsonReader(source).parse();
}

function normalized(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, member]) => [key, normalized(member)]),
    );
  }
  throw new CanonicalError("CANONICAL_VALUE_INVALID");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function closedObject(
  value: unknown,
  required: readonly string[],
  context: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CanonicalError(`${context}_OBJECT_REQUIRED`);
  }
  const object = value as Record<string, unknown>;
  const expected = new Set(required);
  if (Object.keys(object).some((key) => !expected.has(key))) {
    throw new CanonicalError(`${context}_UNKNOWN_MEMBER`);
  }
  if (required.some((key) => !(key in object))) throw new CanonicalError(`${context}_MISSING_MEMBER`);
  return object;
}
