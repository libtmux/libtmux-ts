/**
 * The validators this package needs, and nothing else.
 *
 * These replace Zod so the package ships with no runtime dependencies. That is
 * the whole reason they exist: a consumer installs a tmux client and gets a
 * tmux client, with no third-party code to audit, pin, or deduplicate.
 *
 * The surface is Zod-shaped on purpose — `string().regex(...).nullable()`,
 * `strictObject`, `discriminatedUnion`, `parse`/`safeParse` — so a reader who
 * knows Zod needs no orientation, and so swapping back would be mechanical.
 *
 * Issues carry more than Zod's do. Zod reports the expected type and the
 * received *type*; someone debugging a tmux frame wants the received *value*,
 * so every issue includes it, rendered and length-capped. `zod/mini` would
 * have been smaller than classic Zod, but it answers every failure with
 * "Invalid input" unless its locale is loaded, which costs more than all of
 * this does.
 */

type IssueCode =
  | "invalid_type"
  | "invalid_literal"
  | "invalid_format"
  | "unrecognized_keys"
  | "invalid_union"
  | "too_small";

export interface Issue {
  readonly code: IssueCode;
  readonly expected: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly received: string;
}

export class ValidationFailure extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(issues[0]?.message ?? "validation failed");
    this.name = "ValidationFailure";
    this.issues = Object.freeze([...issues]);
  }

  format(): string {
    return this.issues
      .map(
        (issue) => `${issue.path.length === 0 ? "<root>" : issue.path.join(".")}: ${issue.message}`,
      )
      .join("\n");
  }
}

export type Result<T> =
  | { readonly issues: readonly Issue[]; readonly success: false }
  | { readonly success: true; readonly value: T };

const MAX_RENDER = 60;

function render(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value).slice(0, MAX_RENDER);
  if (value === null || value === undefined || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `array(${String(value.length)})`;
  return `object(${Object.keys(value).slice(0, 3).join(",")})`;
}

function issue(
  code: IssueCode,
  expected: string,
  value: unknown,
  path: readonly (string | number)[],
  message?: string,
): Issue {
  const received = render(value);
  return {
    code,
    expected,
    message: message ?? `expected ${expected}, received ${received}`,
    path,
    received,
  };
}

const ok = <T>(value: T): Result<T> => ({ success: true, value });
const bad = (single: Issue): Result<never> => ({ issues: [single], success: false });

/**
 * The base every validator extends.
 *
 * `run` is the only thing a subclass implements; the combinators here are
 * shared, which is what keeps chaining from costing anything per type.
 */
export abstract class Validator<T> {
  abstract run(value: unknown, path: readonly (string | number)[]): Result<T>;

  nullable(): Validator<T | null> {
    return new NullableValidator(this);
  }

  refine(predicate: (value: T) => boolean, expected: string): Validator<T> {
    return new RefinedValidator(this, predicate, expected);
  }

  safeParse(value: unknown): Result<T> {
    return this.run(value, []);
  }

  parse(value: unknown): T {
    const result = this.run(value, []);
    if (result.success) return result.value;
    throw new ValidationFailure(result.issues);
  }
}

export type Infer<V> = V extends Validator<infer T> ? T : never;

class NullableValidator<T> extends Validator<T | null> {
  readonly #inner: Validator<T>;
  constructor(inner: Validator<T>) {
    super();
    this.#inner = inner;
  }
  run(value: unknown, path: readonly (string | number)[]): Result<T | null> {
    return value === null ? ok(null) : this.#inner.run(value, path);
  }
}

class RefinedValidator<T> extends Validator<T> {
  readonly #inner: Validator<T>;
  readonly #predicate: (value: T) => boolean;
  readonly #expected: string;
  constructor(inner: Validator<T>, predicate: (value: T) => boolean, expected: string) {
    super();
    this.#inner = inner;
    this.#predicate = predicate;
    this.#expected = expected;
  }
  run(value: unknown, path: readonly (string | number)[]): Result<T> {
    const result = this.#inner.run(value, path);
    if (!result.success) return result;
    return this.#predicate(result.value)
      ? result
      : bad(issue("invalid_format", this.#expected, result.value, path));
  }
}

class StringValidator extends Validator<string> {
  readonly #pattern: { label: string; test: RegExp } | undefined;
  readonly #least: number | undefined;
  constructor(pattern?: { label: string; test: RegExp }, least?: number) {
    super();
    this.#pattern = pattern;
    this.#least = least;
  }
  regex(test: RegExp, label: string): StringValidator {
    return new StringValidator({ label, test }, this.#least);
  }
  min(least: number): StringValidator {
    return new StringValidator(this.#pattern, least);
  }
  run(value: unknown, path: readonly (string | number)[]): Result<string> {
    if (typeof value !== "string") return bad(issue("invalid_type", "string", value, path));
    if (this.#least !== undefined && value.length < this.#least) {
      return bad(issue("too_small", `at least ${String(this.#least)} characters`, value, path));
    }
    if (this.#pattern !== undefined && !this.#pattern.test.test(value)) {
      return bad(issue("invalid_format", this.#pattern.label, value, path));
    }
    return ok(value);
  }
}

class LiteralValidator<T extends string | number | boolean> extends Validator<T> {
  readonly #expected: T;
  constructor(expected: T) {
    super();
    this.#expected = expected;
  }
  run(value: unknown, path: readonly (string | number)[]): Result<T> {
    return value === this.#expected
      ? ok(this.#expected)
      : bad(issue("invalid_literal", JSON.stringify(this.#expected), value, path));
  }
}

class UnknownValidator extends Validator<unknown> {
  run(value: unknown): Result<unknown> {
    return ok(value);
  }
}

class RecordValidator<T> extends Validator<Record<string, T>> {
  readonly #values: Validator<T>;
  constructor(values: Validator<T>) {
    super();
    this.#values = values;
  }
  run(value: unknown, path: readonly (string | number)[]): Result<Record<string, T>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return bad(issue("invalid_type", "object", value, path));
    }
    const out: Record<string, T> = Object.create(null) as Record<string, T>;
    const issues: Issue[] = [];
    for (const [key, entry] of Object.entries(value)) {
      const result = this.#values.run(entry, [...path, key]);
      if (result.success) out[key] = result.value;
      else issues.push(...result.issues);
    }
    return issues.length === 0 ? ok(out) : { issues, success: false };
  }
}

type Shape = Readonly<Record<string, Validator<unknown>>>;
type InferShape<S extends Shape> = { readonly [K in keyof S]: Infer<S[K]> };

class StrictObjectValidator<S extends Shape> extends Validator<InferShape<S>> {
  readonly #shape: S;
  readonly #keys: readonly string[];
  constructor(shape: S) {
    super();
    this.#shape = shape;
    this.#keys = Object.keys(shape);
  }
  run(value: unknown, path: readonly (string | number)[]): Result<InferShape<S>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return bad(issue("invalid_type", "object", value, path));
    }
    const present = new Set(Object.keys(value));
    const issues: Issue[] = [];
    const out: Record<string, unknown> = {};
    for (const key of this.#keys) {
      present.delete(key);
      const result = this.#shape[key]!.run((value as Record<string, unknown>)[key], [...path, key]);
      if (result.success) out[key] = result.value;
      else issues.push(...result.issues);
    }
    if (present.size > 0) {
      const unexpected = [...present];
      issues.push({
        code: "unrecognized_keys",
        expected: `only the ${String(this.#keys.length)} declared keys`,
        message: `unrecognized ${unexpected.length === 1 ? "key" : "keys"}: ${unexpected.slice(0, 5).join(", ")}`,
        path,
        received: unexpected.slice(0, 5).join(", "),
      });
    }
    return issues.length === 0 ? ok(out as InferShape<S>) : { issues, success: false };
  }
}

class DiscriminatedUnionValidator<T> extends Validator<T> {
  readonly #discriminator: string;
  readonly #options: readonly Validator<T>[];
  readonly #labels: readonly string[];
  constructor(discriminator: string, options: readonly Validator<T>[], labels: readonly string[]) {
    super();
    this.#discriminator = discriminator;
    this.#options = options;
    this.#labels = labels;
  }
  run(value: unknown, path: readonly (string | number)[]): Result<T> {
    if (typeof value !== "object" || value === null) {
      return bad(issue("invalid_type", "object", value, path));
    }
    const tag = (value as Record<string, unknown>)[this.#discriminator];
    const index = this.#labels.indexOf(String(tag));
    if (index === -1) {
      return bad(
        issue(
          "invalid_union",
          `${this.#discriminator} to be one of ${this.#labels.join(" | ")}`,
          tag,
          [...path, this.#discriminator],
        ),
      );
    }
    return this.#options[index]!.run(value, path);
  }
}

export const v = {
  /**
   * Members carry different shapes — that is what the discriminator is for —
   * so the result is the union of what they accept, not one shape they must
   * all share.
   */
  discriminatedUnion: <const Options extends readonly Validator<unknown>[]>(
    discriminator: string,
    options: Options,
    labels: readonly string[],
  ): Validator<Infer<Options[number]>> =>
    new DiscriminatedUnionValidator<Infer<Options[number]>>(
      discriminator,
      options as readonly Validator<Infer<Options[number]>>[],
      labels,
    ),
  literal: <const T extends string | number | boolean>(expected: T): Validator<T> =>
    new LiteralValidator(expected),
  record: <T>(values: Validator<T>): Validator<Record<string, T>> => new RecordValidator(values),
  strictObject: <S extends Shape>(shape: S): Validator<InferShape<S>> =>
    new StrictObjectValidator(shape),
  string: (): StringValidator => new StringValidator(),
  unknown: (): Validator<unknown> => new UnknownValidator(),
};
