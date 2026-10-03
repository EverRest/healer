/**
 * Collected text is data, never an instruction (003 T009, FR-021, R-11).
 *
 * An excerpt is wrapped in `Untrusted`, a class with a `#private` field: it is nominal, so it is
 * **not** assignable to `string`, to a `DecisionInput` field, to a tool argument or to any
 * parameter that is not itself declared `Untrusted`. The planner, the ranker and the dedup key
 * builder declare no such parameter, so `make typecheck` rejects a path from collected text into a
 * predicate (T010). A branded string (`string & {brand}`) would not do: it is still assignable to
 * `string`, which is exactly the parameter every one of those functions has.
 *
 * The wrapper also refuses to serialise: `JSON.stringify`, template literals and Pino all see a
 * placeholder, so a log line cannot accidentally carry the text onward.
 */
export class Untrusted<T extends string = string> {
  readonly #value: T;

  private constructor(value: T) {
    this.#value = value;
  }

  static wrap<T extends string>(value: T): Untrusted<T> {
    return new Untrusted(value);
  }

  /**
   * The one way out, named so a grep finds every consumer. The only legitimate callers are the
   * read surface (renders it marked) and the prompt assembler (wraps it as quoted data) — T080.
   */
  revealForMarkedRenderOrPrompt(): T {
    return this.#value;
  }

  toJSON(): string {
    return '[untrusted]';
  }

  toString(): string {
    return '[untrusted]';
  }
}
