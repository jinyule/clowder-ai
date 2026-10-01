/**
 * Lossless JSON reading for hook configs shared with other tools (#1566). Numbers keep their exact
 * lexeme, duplicate keys are rejected (JSON.parse silently keeps the last one, Codex rejects the
 * file), objects have no prototype, and every container records its source offsets so Clowder can
 * splice its own entries without re-serialising anyone else's bytes.
 */

export class JsonNumber {
  constructor(readonly raw: string) {}

  get value(): number {
    return Number(this.raw);
  }
}

export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ElementSpan {
  start: number;
  end: number;
}

export interface ArraySource {
  open: number;
  close: number;
  items: ElementSpan[];
}

export interface MemberSpan extends ElementSpan {
  /** Offset of the opening quote of the key; `start`/`end` delimit the value. */
  keyStart: number;
}

export interface ObjectSource {
  open: number;
  close: number;
  /** In source order. */
  members: Map<string, MemberSpan>;
}

export interface JsonSource {
  text: string;
  value: JsonValue;
  arrays: WeakMap<JsonValue[], ArraySource>;
  objects: WeakMap<JsonObject, ObjectSource>;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof JsonNumber);
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_DEPTH = 256;

class JsonSourceError extends Error {}

class Parser {
  private index = 0;
  readonly arrays = new WeakMap<JsonValue[], ArraySource>();
  readonly objects = new WeakMap<JsonObject, ObjectSource>();

  constructor(private readonly text: string) {}

  parseDocument(): JsonValue {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail('unexpected trailing content');
    return value;
  }

  private fail(message: string): never {
    throw new JsonSourceError(`${message} at offset ${this.index}`);
  }

  private skipWhitespace(): void {
    while (' \t\n\r'.includes(this.text[this.index] ?? 'x')) this.index++;
  }

  private parseValue(depth: number): JsonValue {
    if (depth > MAX_DEPTH) this.fail('nesting too deep');
    this.skipWhitespace();
    const char = this.text[this.index];
    if (char === '{') return this.parseObject(depth);
    if (char === '[') return this.parseArray(depth);
    if (char === '"') return this.parseString();
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }
    NUMBER.lastIndex = this.index;
    const number = NUMBER.exec(this.text);
    if (!number) this.fail('unexpected token');
    this.index += number[0].length;
    return new JsonNumber(number[0]);
  }

  private parseString(): string {
    const start = this.index;
    this.index++;
    while (this.index < this.text.length && this.text[this.index] !== '"') {
      this.index += this.text[this.index] === '\\' ? 2 : 1;
    }
    if (this.index >= this.text.length) this.fail('unterminated string');
    this.index++;
    try {
      return JSON.parse(this.text.slice(start, this.index)) as string;
    } catch {
      this.index = start;
      return this.fail('invalid string');
    }
  }

  /** Parses `item (, item)*` up to `closer`, leaving the index on the closer. */
  private parseSequence(closer: string, parseItem: () => void): void {
    this.skipWhitespace();
    if (this.text[this.index] === closer) return;
    for (;;) {
      this.skipWhitespace();
      parseItem();
      this.skipWhitespace();
      if (this.text[this.index] === closer) return;
      if (this.text[this.index] !== ',') this.fail(`expected , or ${closer}`);
      this.index++;
    }
  }

  private parseArray(depth: number): JsonValue[] {
    const array: JsonValue[] = [];
    const source: ArraySource = { open: this.index, close: -1, items: [] };
    this.index++;
    this.parseSequence(']', () => {
      const start = this.index;
      array.push(this.parseValue(depth + 1));
      source.items.push({ start, end: this.index });
    });
    source.close = this.index++;
    this.arrays.set(array, source);
    return array;
  }

  private parseObject(depth: number): JsonObject {
    const object = Object.create(null) as JsonObject;
    const source: ObjectSource = { open: this.index, close: -1, members: new Map() };
    this.index++;
    this.parseSequence('}', () => this.parseMember(object, source, depth));
    source.close = this.index++;
    this.objects.set(object, source);
    return object;
  }

  private parseMember(object: JsonObject, source: ObjectSource, depth: number): void {
    const keyStart = this.index;
    if (this.text[this.index] !== '"') this.fail('expected a string key');
    const key = this.parseString();
    if (source.members.has(key)) this.fail(`duplicate key ${JSON.stringify(key)}`);
    this.skipWhitespace();
    if (this.text[this.index] !== ':') this.fail('expected :');
    this.index++;
    this.skipWhitespace();
    const start = this.index;
    object[key] = this.parseValue(depth + 1);
    source.members.set(key, { keyStart, start, end: this.index });
  }
}

export function parseJsonSource(text: string): { ok: true; source: JsonSource } | { ok: false; reason: string } {
  const parser = new Parser(text);
  try {
    const value = parser.parseDocument();
    return { ok: true, source: { text, value, arrays: parser.arrays, objects: parser.objects } };
  } catch (error) {
    if (error instanceof JsonSourceError) return { ok: false, reason: `not valid JSON: ${error.message}` };
    throw error;
  }
}
