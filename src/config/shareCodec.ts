/**
 * The v8 document as BYTES, for the share link.
 *
 * PURE, like `persistence.ts` and `shareLink.ts` -- no DOM, no `window`, no
 * `Buffer`. Everything below is `ArrayBuffer` and `DataView`, which is what lets
 * it run unchanged in the browser and under `node --test`.
 *
 * ## A CODEC, NOT A FORMAT
 *
 * `persistence.ts` says there is "exactly one interpreter of these bytes". This
 * file does not join it. It turns a v8 document into a byte string and back, and
 * `decode` returns the SAME SHAPE `JSON.parse` would have returned for the same
 * document -- so `fromDocument` remains the only thing that decides what any of
 * it MEANS. Nothing here validates a range, applies a default, or knows why a
 * field exists.
 *
 * That is the whole reason this is a separate file from `shareLink.ts`: the link
 * chooses a transport, and this chooses a representation. Neither is a reader.
 *
 * ## WHY BINARY AT ALL
 *
 * Measured against the 176 configs in `configs/Archive/`: a one-config project
 * is ~1789 characters as JSON-then-lz-string, and ~527 as these bytes. The
 * reason is not that lz-string is bad -- it is that the payload is 80 float32s
 * per config drawn from a chaotic hash, and:
 *
 *   1. `JSON.stringify` prints a float32 with up to 17 significant digits
 *      (`0.9860000014305115` is 18 characters carrying 4 bytes), and
 *   2. those mantissas are effectively random, so there is NO REDUNDANCY for a
 *      text compressor to find. Brotli-11 over the raw rule bytes recovers 3%.
 *
 * So the win here is not compression. It is not spending 18 characters on 4
 * bytes. Adding a general-purpose compressor on top of this would buy ~3% for a
 * dependency and a decompression step; it was measured and deliberately skipped.
 *
 * ## THE TRAP THAT DICTATES THE FLOAT WIDTHS
 *
 * **NOT EVERY NUMBER IN A SAVED DOCUMENT IS FLOAT32.** This is the one thing
 * that makes a binary encoding here subtle, it was found by scanning the real
 * `configs/`, and getting it wrong fails SILENTLY:
 *
 *   - All 15,680 `rule` floats across every shipped config are exactly float32.
 *     They come off the GPU, so they can only ever have been float32.
 *   - 312 SCALARS ARE NOT. `mutation_seed` is float64 in 194 of 196 configs
 *     (`0.024925940576650873`), and `sensor_distance_jitter`, `hazard_rate`,
 *     `mutation_scale` and `sensor_angle_jitter` each hold some too. They are
 *     produced by UI sliders and arithmetic in JavaScript, which is float64.
 *
 * Storing those as float32 would round them. For `mutation_seed` that is the
 * failure `persistence.ts:204` calls the most dangerous in the file: the value
 * is fed to a chaotic hash, so a rounded seed is a DIFFERENT RULE that still
 * looks entirely legitimate. Nobody would see a bug; they would see a link that
 * opens something subtly other than what was shared.
 *
 * Hence the asymmetry below, which is the core design decision of this file:
 * **the rule array is float32 and the scalars are float64.** It costs 8 bytes
 * per scalar where 4 would do, and it is worth it -- there are 16 scalars and 80
 * rule floats per config, so the rule is what governs the size and the scalars
 * are where the precision has to be right. `roundTripsExactly` proves the claim
 * for the whole corpus rather than asserting it.
 *
 * ## WHAT IS AND IS NOT PRESERVED
 *
 * Byte-exact for every numeric value, the config count, and the notes string.
 *
 * The KEY LAYOUT is fixed rather than stored: this writes the same group
 * structure `toDocument` writes. Two consequences are deliberate and both are
 * tested:
 *
 *   - A document carrying `appearance` (the pre-rename spelling of `misc2`) or
 *     a `camera` block re-emerges WITHOUT them. `persistence.ts` already ignores
 *     both, so nothing is lost that any reader would have read -- but it means
 *     encode/decode is a NORMALIZING round trip for legacy files, not an
 *     identity one. `encodeDocument` is therefore given the document
 *     `toDocument` produced, never a file straight off disk.
 *   - `cohort_fences` is written as the BOOLEAN `toDocument` writes today. Files
 *     on disk still hold a float there, and `fencesOr` reads both.
 */

/**
 * The codec version, first byte of every payload.
 *
 * SEPARATE FROM `FORMAT_VERSION`. That one versions what the fields MEAN and is
 * owned by `persistence.ts`; this one versions how they are laid out in bytes.
 * They move independently -- a new field bumps the format, a changed float width
 * bumps this -- and conflating them would make either change require the other.
 *
 * The document's own `version` is still written into the payload, so a v9
 * document round-trips through here intact and is rejected by `fromDocument`,
 * which is the layering `shareLink.test.ts` asserts.
 */
export const CODEC_VERSION = 2;

/**
 * Scalars carried by a version-1 payload.
 *
 * V1 IS A STRICT PREFIX OF V2. The Density Image field appended three scalars to
 * `SCALARS`; every offset before them is unchanged, so a v1 payload is a v2
 * payload with the tail missing, and the tail's absence means zero -- which is
 * exactly what "no image bias" is, and the same argument `persistence.ts` makes
 * for a save file with no `misc3` keys.
 *
 * SO THE DECODER READS BOTH, which is a deliberate departure from how this
 * project treats the v7 document format. That refusal ("v7 is absent by
 * construction") is right because v7 fields MEAN something different and
 * migration is one-way and offline. A share link is neither: it is a URL already
 * posted somewhere nobody controls, with no migration path and no owner to
 * re-issue it. Rejecting v1 would break every link ever shared to buy nothing --
 * there is no ambiguity to resolve, because the missing bytes have exactly one
 * possible reading.
 */
const SCALARS_V1_COUNT = 16;

/** Thrown for bytes this decoder will not accept. */
export class ShareCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareCodecError';
  }
}

/** 10 FourierCenters x (frequency vec4 + amplitude vec4). Mirrors `config.ts`. */
const RULE_FLOAT_COUNT = 80;

/**
 * The scalars, in write order, as `[group, key]`.
 *
 * ORDER IS THE FORMAT. Reordering this array silently changes what every
 * existing link decodes to, which is why it is one table used by BOTH
 * directions rather than two matching lists that could drift apart.
 *
 * All sixteen are float64 -- see the header on why the five that need it are not
 * separated from the eleven that do not. Uniformity here costs 44 bytes per
 * config and removes an entire class of "which one was it?" mistake.
 */
const SCALARS: readonly (readonly [string, string])[] = [
  ['sensor', 'gain'],
  ['sensor', 'angle'],
  ['sensor', 'distance'],
  ['sensor', 'mutation_scale'],
  ['force', 'global_mult'],
  ['force', 'drag'],
  ['force', 'strafe'],
  ['force', 'axial'],
  ['misc', 'lateral'],
  ['misc', 'hazard_rate'],
  ['misc', 'mutation_seed'],
  ['force2', 'gravity_force'],
  ['force2', 'gravity_strafe'],
  ['misc2', 'color_sensitivity'],
  ['misc2', 'sensor_angle_jitter'],
  ['misc2', 'sensor_distance_jitter'],
  // APPENDED, never inserted. The three above this line are at the offsets
  // every v1 link was written against, so adding here costs those links
  // nothing -- see SCALARS_V1_COUNT.
  ['misc3', 'density_force'],
  ['misc3', 'density_strafe'],
  ['misc3', 'density_sense'],
] as const;

/**
 * The booleans, in bit order within the flag byte.
 *
 * Three bits used of eight. The spare five are why a fourth boolean can be added
 * without changing a single byte offset -- and `initial_conditions` sits in its
 * own byte rather than being packed into the same one for the same reason: it is
 * an enum that has grown before (four modes now, two once), and a two-bit field
 * would have to move the moment a fifth appears.
 */
const FLAGS: readonly (readonly [string, string])[] = [
  ['force2', 'cohort_fences'],
  ['misc2', 'color_by_cohort'],
  ['misc3', 'radial_gravity'],
] as const;

// ---------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------

/** A JSON object, or `{}`. Matches `persistence.ts`'s `block`. */
function block(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A number for the encoder, or 0.
 *
 * TOLERANT ON PURPOSE, and it is not this file's job to be otherwise: a document
 * with a missing or malformed field must reach `fromDocument` to be rejected
 * with a message naming the field. Throwing here would replace that message with
 * a bytes-level one, and refusing to encode would stop a user sharing a document
 * the app had happily loaded.
 *
 * `cohort_fences` is the case that makes this load-bearing rather than
 * defensive: it is a float in every file on disk and a boolean in everything
 * written since, so the encoder meets both.
 */
function numberOr(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Truthy under both shapes `cohort_fences` has had: `true`, or a float > 0. */
function flagOf(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  return false;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Bytes per config: the rule, the scalars, cohorts, the enum, the flag byte.
 *
 * Computed rather than written as a literal so that adding a scalar cannot leave
 * a stale constant behind -- the allocation and the writer would disagree by
 * exactly the amount that makes the last config overrun.
 */
function configBytesFor(scalarCount: number): number {
  return (
    RULE_FLOAT_COUNT * 4 + // rule, float32 -- see the header
    scalarCount * 8 + //     scalars, float64 -- see the header
    4 + //                   cohorts, uint32 (up to 300000 in the shipped configs)
    1 + //                   initial_conditions
    1 //                     the flag byte
  );
}

/** Bytes per config in the version this build WRITES. */
const CONFIG_BYTES = configBytesFor(SCALARS.length);

/** How many scalars a payload of a given codec version carries. */
function scalarCountFor(codec: number): number {
  return codec === 1 ? SCALARS_V1_COUNT : SCALARS.length;
}

/** version + document version + config count + the three world values. */
const HEADER_BYTES = 1 + 1 + 2 + 8 + 8 + 1;

/**
 * A v8 document as bytes.
 *
 * Takes `unknown` and reads defensively for the reason `numberOr` states: this
 * sits on the WRITE path, where refusing to act is worse than emitting a
 * document that the reader will reject on arrival with a better message.
 */
export function encodeDocument(document: unknown): Uint8Array {
  const doc = block(document);
  const world = block(doc['world']);
  const configsRaw = Array.isArray(doc['configs']) ? doc['configs'] : [];

  // The count is a uint16 and 65535 configs is far beyond anything the app can
  // build, but a truncating cast would wrap silently and emit a payload that
  // decodes to the wrong number of configs. Refused instead.
  if (configsRaw.length > 0xffff) {
    throw new ShareCodecError(`too many configs to encode (${configsRaw.length})`);
  }

  const notes = typeof doc['notes'] === 'string' ? doc['notes'] : '';
  // UTF-8 BEFORE the buffer is sized, because the byte length of a string is not
  // its `.length` -- an emoji in the notes is four bytes and one to three UTF-16
  // units. Sizing off `.length` would under-allocate exactly when someone used a
  // character outside the BMP.
  const notesBytes = new TextEncoder().encode(notes);

  const total =
    HEADER_BYTES + configsRaw.length * CONFIG_BYTES + 4 + notesBytes.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  let at = 0;

  view.setUint8(at, CODEC_VERSION);
  at += 1;
  // The DOCUMENT's version, carried rather than assumed -- so a v9 document
  // survives this file and is rejected by `fromDocument`, not here.
  view.setUint8(at, typeof doc['version'] === 'number' ? doc['version'] : 0);
  at += 1;
  view.setUint16(at, configsRaw.length, true);
  at += 2;
  view.setFloat64(at, numberOr(world, 'trail_persistence'), true);
  at += 8;
  view.setFloat64(at, numberOr(world, 'trail_diffusion'), true);
  at += 8;
  view.setUint8(at, numberOr(world, 'boundary_conditions'));
  at += 1;

  for (const entry of configsRaw) {
    const config = block(entry);
    const groups: Record<string, Record<string, unknown>> = {
      sensor: block(config['sensor']),
      force: block(config['force']),
      misc: block(config['misc']),
      force2: block(config['force2']),
      // The pre-rename spelling, read exactly as `configFromDocument` reads it.
      misc2:
        config['misc2'] !== undefined
          ? block(config['misc2'])
          : block(config['appearance']),
      misc3: block(config['misc3']),
    };

    const rule = Array.isArray(config['rule']) ? config['rule'] : [];
    for (let i = 0; i < RULE_FLOAT_COUNT; i += 1) {
      const value = rule[i];
      // FLOAT32, and this is the one place the width is a claim about the data
      // rather than a choice: every rule float in the corpus is exactly float32
      // because it came off the GPU. `roundTripsExactly` is what keeps that
      // claim honest for documents this file has never seen.
      view.setFloat32(at, typeof value === 'number' ? value : 0, true);
      at += 4;
    }

    for (const [group, key] of SCALARS) {
      view.setFloat64(at, numberOr(groups[group]!, key), true);
      at += 8;
    }

    view.setUint32(at, Math.max(0, numberOr(groups['misc']!, 'cohorts')), true);
    at += 4;
    view.setUint8(at, numberOr(groups['force2']!, 'initial_conditions') & 0xff);
    at += 1;

    let flags = 0;
    FLAGS.forEach(([group, key], bit) => {
      if (flagOf(groups[group]!, key)) flags |= 1 << bit;
    });
    view.setUint8(at, flags);
    at += 1;
  }

  view.setUint32(at, notesBytes.length, true);
  at += 4;
  bytes.set(notesBytes, at);

  return bytes;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * The document those bytes carry.
 *
 * Returns the shape `JSON.parse` would have returned, so the caller cannot tell
 * which transport a document arrived on -- which is what keeps `fromDocument`
 * the only reader. Throws `ShareCodecError` for bytes that are the wrong length
 * or the wrong codec version; everything else is the reader's business.
 */
export function decodeDocument(bytes: Uint8Array): unknown {
  if (bytes.length < HEADER_BYTES) {
    throw new ShareCodecError('the payload is too short to be a config');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;

  const codec = view.getUint8(at);
  at += 1;
  if (codec < 1 || codec > CODEC_VERSION) {
    // A LINK FROM A FUTURE BUILD, and the message says so rather than calling it
    // damaged -- the user's remedy is to update, not to ask for a fresh copy.
    // Codec 0 lands here too, which is right: there was never a version 0, so
    // those bytes are not a link at all.
    throw new ShareCodecError(
      `this link uses share format ${codec}, which this version cannot read ` +
        `(it reads up to ${CODEC_VERSION}) -- the page may need updating`,
    );
  }
  // Every offset after the header depends on this, so it is resolved once here
  // rather than tested per config.
  const scalarCount = scalarCountFor(codec);
  const configBytes = configBytesFor(scalarCount);

  const version = view.getUint8(at);
  at += 1;
  const configCount = view.getUint16(at, true);
  at += 2;
  const trailPersistence = view.getFloat64(at, true);
  at += 8;
  const trailDiffusion = view.getFloat64(at, true);
  at += 8;
  const boundaryConditions = view.getUint8(at);
  at += 1;

  // LENGTH CHECKED BEFORE ANY OF IT IS READ. A truncated payload is the likeliest
  // real failure (`shareLink.ts` trap 2), and a `DataView` past its end throws a
  // `RangeError`, not something a caller can tell from a bug. Checked up front so
  // the error names truncation, which is what actually happened.
  const needed = HEADER_BYTES + configCount * configBytes + 4;
  if (bytes.length < needed) {
    throw new ShareCodecError(
      `the payload claims ${configCount} configs but is ${bytes.length} bytes, ` +
        `short of the ${needed} they need`,
    );
  }

  const configs: unknown[] = [];
  for (let c = 0; c < configCount; c += 1) {
    const rule: number[] = [];
    for (let i = 0; i < RULE_FLOAT_COUNT; i += 1) {
      rule.push(view.getFloat32(at, true));
      at += 4;
    }

    // Padded to the CURRENT scalar count so every index below is in range for a
    // v1 payload too. The pad is 0, which is what a missing density lane means.
    const values: number[] = [];
    for (let i = 0; i < scalarCount; i += 1) {
      values.push(view.getFloat64(at, true));
      at += 8;
    }
    while (values.length < SCALARS.length) values.push(0);

    const cohorts = view.getUint32(at, true);
    at += 4;
    const initialConditions = view.getUint8(at);
    at += 1;
    const flags = view.getUint8(at);
    at += 1;

    // Rebuilt in `toDocument`'s key order and grouping. See the header: this is
    // a normalizing round trip, so a legacy `appearance` or `camera` block does
    // not come back -- neither is read by `persistence.ts`.
    configs.push({
      rule,
      sensor: {
        gain: values[0]!,
        angle: values[1]!,
        distance: values[2]!,
        mutation_scale: values[3]!,
      },
      force: {
        global_mult: values[4]!,
        drag: values[5]!,
        strafe: values[6]!,
        axial: values[7]!,
      },
      misc: {
        lateral: values[8]!,
        hazard_rate: values[9]!,
        cohorts,
        mutation_seed: values[10]!,
      },
      force2: {
        gravity_force: values[11]!,
        gravity_strafe: values[12]!,
        initial_conditions: initialConditions,
        cohort_fences: (flags & 1) !== 0,
      },
      misc2: {
        color_sensitivity: values[13]!,
        color_by_cohort: (flags & 2) !== 0,
        sensor_angle_jitter: values[14]!,
        sensor_distance_jitter: values[15]!,
      },
      misc3: {
        radial_gravity: (flags & 4) !== 0,
        density_force: values[16]!,
        density_strafe: values[17]!,
        density_sense: values[18]!,
      },
    });
  }

  const notesLength = view.getUint32(at, true);
  at += 4;
  if (bytes.length < at + notesLength) {
    throw new ShareCodecError('the payload ends inside its notes');
  }
  const notes = new TextDecoder().decode(
    bytes.subarray(at, at + notesLength),
  );

  const doc: Record<string, unknown> = {
    version,
    world: {
      trail_persistence: trailPersistence,
      trail_diffusion: trailDiffusion,
      boundary_conditions: boundaryConditions,
    },
    configs,
  };
  // OMITTED WHEN EMPTY, matching `toDocument` -- so a document that never had
  // notes round-trips to one that still does not, rather than gaining a `""`.
  if (notes !== '') doc['notes'] = notes;
  return doc;
}

// ---------------------------------------------------------------------------
// THE DENSITY IMAGE BLOCK
// ---------------------------------------------------------------------------
//
// APPENDED AFTER THE NOTES, WHICH IS WHY THERE IS NO VERSION BUMP.
//
// `decodeDocument` reads the notes and returns; it checks that the payload is at
// least as long as it needs and never that it is exactly that long. So trailing
// bytes are already ignored, and a build that predates this block loads such a
// link as the config without the image -- which is the correct degradation, not
// an error. Bumping the codec would instead make those builds REFUSE a link they
// can very nearly read.
//
// The block is read by its own function rather than folded into
// `decodeDocument`. That keeps the document a v8 document: an image is not one of
// its fields, and `fromDocument` would have to learn to ignore a key that no
// save file can contain.

/**
 * Longest edge of the copy that travels in a link.
 *
 * A URL-LENGTH BUDGET, not a quality choice, and the numbers are worth stating
 * because the binary payload is NOT compressed: `encodeShareLink` base64-encodes
 * the bytes directly, so every byte here costs 4/3 of a character. (lz-string is
 * the LEGACY `#c=` path only, and measured on this data it manages 1.4x on
 * smooth input and EXPANDS incompressible input by 1.5x -- it is an LZW over
 * 16-bit chars, not a byte compressor.)
 *
 * At 4 bits per pixel (see below) 128px is 8 KB, which base64s to ~11 KB and
 * leaves a whole link near 12 KB. Well inside what a browser accepts, and inside
 * what survives a paste through a chat client.
 */
export const SHARE_IMAGE_MAX_DIM = 128;

/**
 * Grey levels a shared image keeps: 16, packed two pixels to a byte.
 *
 * ## SPATIAL DETAIL IS WORTH MORE THAN TONAL DETAIL HERE, and that is the trade
 *
 * Halving the bit depth buys the same bytes as dropping to 96px would, and 128px
 * at 4 bits is SMALLER than 96px at 8 (8 KB against 9 KB) while carrying a third
 * more linear resolution. The reason it costs nothing visible is the receiving
 * end: `densityGradient` runs a percentile contrast stretch and then a Gaussian
 * blur BEFORE the Sobel, so absolute levels are renormalized and the terracing
 * quantization introduces is smoothed below the gradient's own scale.
 *
 * What it would break is an image whose meaning is in fine tonal gradations
 * across a flat field -- but that is exactly what a blurred gradient discards
 * anyway, so there is no configuration in which the extra bits reach a particle.
 *
 * `densityGradient.test.ts` pins the claim rather than asserting it: it compares
 * a 16-level gradient field against the full-depth one.
 */
const SHARE_IMAGE_LEVELS = 16;

/**
 * Leading byte of the block, so a stray trailing byte is not read as an image.
 *
 * A payload can acquire trailing bytes innocently -- base64 padding decoded by a
 * lenient implementation, or a chat client appending whitespace. Without a magic
 * byte, one such byte would be read as a width and the decoder would go looking
 * for megabytes of pixels.
 */
const IMAGE_MAGIC = 0xd1;

/** width(2) + height(2) + scale(4), then the packed 4-bit pixels. */
const IMAGE_HEADER_BYTES = 1 + 2 + 2 + 4;

/** Bytes the pixels occupy at 4 bits each, rounded up for an odd count. */
function packedPixelBytes(width: number, height: number): number {
  return Math.ceil((width * height) / 2);
}

export interface SharedImage {
  readonly width: number;
  readonly height: number;
  /** `width * height` greyscale bytes. */
  readonly gray: Uint8Array;
  /** The Image Scale slider's value. See `densityScale.ts`. */
  readonly scale: number;
}

/** The block, ready to concatenate onto an `encodeDocument` payload. */
export function encodeImageBlock(image: SharedImage): Uint8Array {
  const pixels = image.width * image.height;
  const out = new Uint8Array(
    IMAGE_HEADER_BYTES + packedPixelBytes(image.width, image.height),
  );
  const view = new DataView(out.buffer);
  view.setUint8(0, IMAGE_MAGIC);
  view.setUint16(1, image.width, true);
  view.setUint16(3, image.height, true);
  // float32, not float64: the value is a slider position between 0.2 and 6, so
  // four bytes carry it to more precision than the control can express.
  view.setFloat32(5, image.scale, true);

  // Two pixels per byte, low nibble first. `>> 4` rather than a divide-and-round
  // so the mapping is exactly the inverse of the `* 17` below: 255 -> 15 -> 255.
  for (let i = 0; i < pixels; i++) {
    const level = (image.gray[i] ?? 0) >> 4;
    const at = IMAGE_HEADER_BYTES + (i >> 1);
    out[at] = i % 2 === 0 ? level : (out[at] ?? 0) | (level << 4);
  }
  return out;
}

/**
 * The image block at the end of a payload, or `null` if there is not one.
 *
 * NEVER THROWS. Every failure -- no block, wrong magic, a truncated tail, a size
 * that does not add up -- returns `null`, because the config in front of the
 * block is still perfectly good. A link whose image was mangled in transit
 * should open as the project without the image, not fail to open at all. That is
 * the opposite of `decodeDocument`'s stance, and deliberately: there, a bad byte
 * means the thing the user asked for cannot be produced.
 */
export function decodeImageBlock(bytes: Uint8Array): SharedImage | null {
  const start = imageBlockOffset(bytes);
  if (start === null) return null;
  if (bytes.length < start + IMAGE_HEADER_BYTES) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(start) !== IMAGE_MAGIC) return null;

  const width = view.getUint16(start + 1, true);
  const height = view.getUint16(start + 3, true);
  const scale = view.getFloat32(start + 5, true);
  if (width <= 0 || height <= 0) return null;
  // A width and height are two bytes each, so the largest they can claim is
  // 65535 x 65535 -- four billion pixels. The length check below is what makes
  // that harmless, and it is checked before anything is allocated.
  const pixels = width * height;
  const packed = packedPixelBytes(width, height);
  const from = start + IMAGE_HEADER_BYTES;
  if (bytes.length < from + packed) return null;

  // Unpacked to full bytes here, so nothing downstream has to know the wire
  // format. `* 17` spreads 0..15 across 0..255 exactly -- 15 * 17 is 255 -- where
  // `<< 4` would cap at 240 and darken every shared image by 6%.
  const gray = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const byte = bytes[from + (i >> 1)] ?? 0;
    gray[i] = ((i % 2 === 0 ? byte & 0x0f : byte >> 4) * 255) / (SHARE_IMAGE_LEVELS - 1);
  }

  return { width, height, gray, scale };
}

/**
 * Where the block starts: immediately after the notes.
 *
 * Re-walks the header and the configs rather than having `decodeDocument` report
 * the offset, so the two stay independent -- this one must not be able to break
 * document decoding, which is the thing that actually matters in a link.
 * Returns `null` for anything it cannot walk.
 */
function imageBlockOffset(bytes: Uint8Array): number | null {
  if (bytes.length < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codec = view.getUint8(0);
  if (codec < 1 || codec > CODEC_VERSION) return null;
  const configCount = view.getUint16(2, true);
  const at = HEADER_BYTES + configCount * configBytesFor(scalarCountFor(codec));
  if (bytes.length < at + 4) return null;
  const notesLength = view.getUint32(at, true);
  const afterNotes = at + 4 + notesLength;
  if (bytes.length <= afterNotes) return null;
  return afterNotes;
}
