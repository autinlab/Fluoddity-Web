/**
 * How a promoted preset is WRITTEN, as opposed to what it contains.
 *
 * Lifted verbatim out of `linkToConfig.mjs`, which is a CLI with top-level
 * side effects and therefore cannot be imported for one function. Two tools now
 * write files into `configs/`, and they have to agree about the style or the
 * library stops looking like one library.
 */

/**
 * Write `1.0` where JavaScript would write `1`.
 *
 * PURELY COSMETIC, and worth the twelve lines anyway. Every file already in
 * `configs/` was written by the retired Python app, whose `json` module keeps a
 * float's `.0`; JavaScript has one number type and `JSON.stringify(1.0)` is
 * `"1"`. The reader does not care -- both parse to the same double, and
 * `deepEqual` on the parsed documents is exact -- but without this, a preset
 * promoted through this tool is textually unlike its neighbours in a way that
 * shows up in every future diff and makes the library look inconsistent.
 *
 * Scoped to VALUE POSITIONS ONLY (`: 1` and array members), so nothing touches
 * `"version": 8`, `"cohorts": 4` or the enum lanes, which are genuinely
 * integers on both sides and are written without a `.0` there too.
 */
export function withFloatZeros(text) {
  return text
    .split('\n')
    .map((line) => {
      // `"key": <int>` -- but not the keys that are really integers.
      const INTEGER_KEYS = /"(version|cohorts|boundary_conditions|initial_conditions)"/;
      if (INTEGER_KEYS.test(line)) return line;
      return line
        .replace(/(:\s)(-?\d+)(,?)$/, '$1$2.0$3')
        .replace(/^(\s*)(-?\d+)(,?)$/, '$1$2.0$3');
    })
    .join('\n');
}

/** A v8 document as a `configs/*.json` file's exact bytes. */
export function formatPreset(document) {
  return `${withFloatZeros(JSON.stringify(document, null, 2))}\n`;
}
