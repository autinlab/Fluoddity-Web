/**
 * Tests for the share link.
 *
 * ## THE TWO TRAPS ARE THE POINT
 *
 * `shareLink.ts`'s header documents two failures that were found by experiment
 * and that both fail SILENTLY. They get a case each, and each case names what
 * breaks without it:
 *
 *   - `URLSearchParams` decodes `+` as a space, and the compressor's alphabet
 *     contains `+`. A payload routed through it comes back subtly wrong -- not
 *     rejected, WRONG -- and the app parses its query string with exactly that
 *     class, so the wrong instinct is close at hand. `a whole URL round-trips`
 *     is the guard, and it is deliberately written against a payload known to
 *     contain a `+` rather than against whatever the fixture happens to produce.
 *
 *   - A truncated payload decompresses to `''` rather than raising, so a bare
 *     `try`/`catch` would let the commonest real-world failure -- a link cut
 *     short by a chat client -- through as a silent no-op.
 *
 * ## WHAT THIS FILE DOES NOT TEST
 *
 * What a document MEANS. `fromDocument` is the only interpreter of these bytes
 * and stays that way, so the version case below asserts the LAYERING: a v9
 * payload decodes here without complaint and is rejected by `fromDocument`. A
 * version check in this file would be a second reader, which is the thing
 * `persistence.ts` exists to prevent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as LZStringNS from 'lz-string';

import { BC, IC } from '../particleSystem/config.ts';
import { ConfigFormatError, fromDocument, toDocument } from './persistence.ts';
import {
  CODEC_VERSION,
  SHARE_IMAGE_MAX_DIM,
  type SharedImage,
  decodeDocument,
  decodeImageBlock,
  encodeDocument,
  encodeImageBlock,
} from './shareCodec.ts';
import {
  SHARE_LINK_WARN_LENGTH,
  ShareLinkError,
  buildShareUrl,
  decodeShareLink,
  decodeShareText,
  decodeShareImage,
  encodeShareLink,
} from './shareLink.ts';

// Unwrapped exactly as `shareLink.ts` does, and for the reason its import
// comment gives at length: under `node --test` the functions live on `.default`,
// and reading them off the namespace gets `undefined`.
const LZString = (
  (LZStringNS as unknown as { default?: typeof LZStringNS }).default ?? LZStringNS
) as { compressToEncodedURIComponent(input: string): string };

const here = path.dirname(fileURLToPath(import.meta.url));
// src/config -> src -> repo root, which is where `configs/` lives.
const REPO_ROOT = path.join(here, '..', '..');

/** A minimal valid v8 document. Mirrors `persistence.test.ts:46`. */
function validDocument(): Record<string, unknown> {
  return {
    version: 8,
    world: {
      trail_persistence: 0.9,
      trail_diffusion: 1.0,
      boundary_conditions: BC.WRAP,
    },
    configs: [oneConfig(0.01)],
  };
}

/**
 * One config block, its rule lane scaled so callers can tell copies apart.
 *
 * ## THE RULE IS ROUNDED TO FLOAT32, AND THAT IS NOT A CONCESSION
 *
 * `i * step` in JavaScript is float64 arithmetic: `35 * 0.01` is
 * `0.35000000000000003`, a value no rule float can ever hold. Every one of the
 * 15,680 rule floats in the shipped library is exactly float32, because they are
 * read back off the GPU -- so a fixture carrying float64 rules would be testing
 * the codec against data the app cannot produce, and would fail for a reason
 * that says nothing about whether share links work.
 *
 * `Math.fround` makes the fixture honest rather than making the test pass: it
 * asserts byte-exactness over the value space the format actually has. The
 * SCALARS are deliberately left alone -- `mutation_seed` and friends really are
 * float64 in the wild, and `shareCodec.ts` stores them as float64 for exactly
 * that reason. That asymmetry is the codec's central design decision, and this
 * fixture exercises both halves of it.
 */
function oneConfig(step: number): Record<string, unknown> {
  return {
    rule: Array.from({ length: 80 }, (_, i) => Math.fround(i * step)),
    sensor: { gain: 0.3, angle: 0.2, distance: 2.4, mutation_scale: 0.1 },
    force: { global_mult: 0.15, drag: 0.5, strafe: 0.38, axial: 0.37 },
    misc: { lateral: -0.7, hazard_rate: 0.0, cohorts: 1, mutation_seed: 0.82 },
    force2: {
      gravity_force: 0.0,
      gravity_strafe: 0.0,
      initial_conditions: IC.GRID,
      // THE BOOLEAN, which is what `toDocument` writes today. The float this
      // used to hold is the pre-change shape that still sits in every file on
      // disk; it is not lost from the tests, it moved to the case below that
      // exists to pin how the codec normalizes it.
      cohort_fences: true,
    },
    misc2: {
      color_sensitivity: 0.5,
      color_by_cohort: false,
      sensor_angle_jitter: 0.0,
      sensor_distance_jitter: 0.16,
    },
    misc3: {
      radial_gravity: false,
      // The Density Image channels. Present here because `toDocument` writes
      // them and the codec is a NORMALIZING round trip -- the same reason a
      // legacy `appearance` block does not come back out. A fixture that
      // omitted them would be asserting that the codec drops them.
      density_force: 0.0,
      density_strafe: 0.0,
      density_sense: 0.0,
    },
  };
}

const LOC = { origin: 'https://example.github.io', pathname: '/Fluoddity2/', search: '' };

/**
 * A version-1 payload, made by surgery on a version-2 one.
 *
 * Built rather than checked in as bytes so it cannot rot: it is derived from
 * whatever this build encodes, with exactly the change that made v2 -- the codec
 * byte set back to 1 and the three appended density scalars cut out. If some
 * other part of the layout ever moves, this stops being a valid v1 payload and
 * the test fails, which is the correct outcome; a hardcoded blob would keep
 * passing while claiming to test something that no longer exists.
 *
 * Assumes ONE config, which the caller guarantees.
 */
function downgradeToV1(v2: Uint8Array): Uint8Array {
  const HEADER = 1 + 1 + 2 + 8 + 8 + 1;
  const RULE = 80 * 4;
  const V1_SCALARS = 16;
  // The density scalars sit immediately after the 16 a v1 writer would have
  // stopped at.
  const cutAt = HEADER + RULE + V1_SCALARS * 8;
  const cutLength = 3 * 8;
  const out = new Uint8Array(v2.length - cutLength);
  out.set(v2.subarray(0, cutAt), 0);
  out.set(v2.subarray(cutAt + cutLength), cutAt);
  out[0] = 1;
  return out;
}

test('a version-1 link still decodes, with the density channels reading zero', () => {
  // THE POINT: a share link is a URL already posted somewhere nobody controls.
  // Appending three scalars must not invalidate every link ever shared, and the
  // missing bytes have exactly one possible reading -- no image bias.
  const doc = validDocument();
  const v1 = downgradeToV1(encodeDocument(doc));
  const decoded = decodeDocument(v1) as {
    configs: { misc3: Record<string, unknown> }[];
  };

  const misc3 = decoded.configs[0]!.misc3;
  assert.equal(misc3['density_force'], 0);
  assert.equal(misc3['density_strafe'], 0);
  assert.equal(misc3['density_sense'], 0);
  // And the lane that shares the vec4 with them is untouched -- a wrong offset
  // would corrupt this rather than the density values.
  assert.equal(misc3['radial_gravity'], false);
});

test('a version-1 link decodes every field before the appended ones unchanged', () => {
  // The stronger statement: v1 is a strict PREFIX of v2, so everything but the
  // density keys must come back identical. An off-by-one in the scalar count
  // would shift `cohorts` and the flag byte and show up here.
  const doc = validDocument();
  const fromV2 = decodeDocument(encodeDocument(doc)) as Record<string, unknown>;
  const fromV1 = decodeDocument(downgradeToV1(encodeDocument(doc))) as Record<string, unknown>;
  assert.deepEqual(fromV1, fromV2);
});

// ---------------------------------------------------------------------------
// THE DENSITY IMAGE BLOCK
// ---------------------------------------------------------------------------

/** A greyscale fixture with structure on both axes, so a transpose is visible. */
function sharedImageFixture(w = 24, h = 16): SharedImage {
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) gray[y * w + x] = (x * 7 + y * 13) & 0xff;
  }
  return { width: w, height: h, gray, scale: 2.75 };
}

test('an image round-trips through a link, quantized to 16 levels', () => {
  // LOSSY BY DESIGN, and the assertion says so rather than tolerating a fuzz.
  // 4 bits per pixel is what keeps the URL pasteable; `SHARE_IMAGE_LEVELS` in
  // the codec explains why the receiving end cannot tell (it contrast-stretches
  // and blurs before differentiating).
  const image = sharedImageFixture();
  const hash = encodeShareLink(validDocument(), image);
  const back = decodeShareImage(hash);
  assert.ok(back !== null, 'the image must come back');
  assert.equal(back.width, image.width);
  assert.equal(back.height, image.height);

  const expected = [...image.gray].map((v) => Math.round(((v >> 4) * 255) / 15));
  assert.deepEqual([...back.gray], expected);

  // float32, so the scale is compared against its float32 rounding rather than
  // an epsilon -- the same discipline the shove lanes use.
  assert.equal(back.scale, Math.fround(image.scale));
});

test('the quantization is exactly invertible at the ends of the range', () => {
  // Black stays black and WHITE STAYS WHITE. `<< 4` instead of `* 255 / 15`
  // would cap at 240 and darken every shared image by 6% -- invisible on its own
  // and a systematic shift in every gradient built from it.
  const gray = new Uint8Array([0, 255, 16, 240]);
  const back = decodeShareImage(
    encodeShareLink(validDocument(), { width: 4, height: 1, gray, scale: 1 }),
  );
  assert.ok(back !== null);
  assert.equal(back.gray[0], 0);
  assert.equal(back.gray[1], 255);
});

test('an odd pixel count packs and unpacks without losing the last one', () => {
  // Two pixels to a byte, so a 3x1 image needs a rounded-up byte and the tail
  // nibble is padding. Off-by-one here drops the final pixel silently.
  const gray = new Uint8Array([0, 128, 255]);
  const back = decodeShareImage(
    encodeShareLink(validDocument(), { width: 3, height: 1, gray, scale: 1 }),
  );
  assert.ok(back !== null);
  assert.equal(back.gray.length, 3);
  assert.equal(back.gray[2], 255);
});

test('the DOCUMENT still decodes when an image block is appended', () => {
  // THE COMPATIBILITY CLAIM, and the reason there is no codec bump: the block
  // sits past everything `decodeDocument` reads, and that function checks the
  // payload is at least long enough -- never that it is exactly that long.
  const doc = validDocument();
  const withImage = encodeShareLink(doc, sharedImageFixture());
  const without = encodeShareLink(doc, null);
  assert.deepEqual(decodeShareLink(withImage), decodeShareLink(without));
});

test('a link with no image reports none rather than a blank one', () => {
  assert.equal(decodeShareImage(encodeShareLink(validDocument())), null);
  assert.equal(decodeShareImage(encodeShareLink(validDocument(), null)), null);
});

test('decodeShareImage returns null for anything that is not our link', () => {
  // Never throws -- the config is what a link is for, and it should open with or
  // without the picture. Every one of these is a `null`, not an exception.
  for (const hash of ['', '#', '#other=1', '#c=garbage', '#b=!!!not-base64!!!', 'plain text']) {
    assert.equal(decodeShareImage(hash), null, JSON.stringify(hash));
  }
});

test('a truncated image tail is dropped and the config still loads', () => {
  // The realistic failure: a chat client cut the URL short. The pixels are gone
  // but the config in front of them is intact, so the link must still open.
  const full = encodeShareLink(validDocument(), sharedImageFixture());
  const cut = full.slice(0, full.length - 40);
  assert.equal(decodeShareImage(cut), null);
  assert.deepEqual(decodeShareLink(cut), decodeShareLink(encodeShareLink(validDocument())));
});

test('a stray trailing byte is not mistaken for an image', () => {
  // Without the magic byte this would be read as a width and the decoder would
  // go looking for megabytes of pixels that are not there.
  const payload = encodeDocument(validDocument());
  const junk = new Uint8Array(payload.length + 1);
  junk.set(payload, 0);
  junk[payload.length] = 0x20; // a space, which is what an appended newline looks like
  assert.equal(decodeImageBlock(junk), null);
});

test('a block claiming more pixels than it carries is refused', () => {
  // width and height are uint16, so a corrupt pair can claim four billion
  // pixels. The length check has to come before any allocation.
  const image = sharedImageFixture();
  const bytes = encodeImageBlock(image);
  const view = new DataView(bytes.buffer);
  view.setUint16(1, 60000, true);
  const payload = encodeDocument(validDocument());
  const joined = new Uint8Array(payload.length + bytes.length);
  joined.set(payload, 0);
  joined.set(bytes, payload.length);
  assert.equal(decodeImageBlock(joined), null);
});

test('a full-size shared image keeps the URL pasteable', () => {
  // THE BUDGET THIS FEATURE LIVES INSIDE. A share link is something someone
  // pastes into a message box, so the size is a design constraint rather than an
  // implementation detail -- and it is worth failing here if it ever doubles.
  //
  // A worst-case fixture: pseudo-random bytes, which lz-string cannot compress.
  // Real density data is smooth and does much better, so this is a ceiling.
  let seed = 7;
  const n = SHARE_IMAGE_MAX_DIM * SHARE_IMAGE_MAX_DIM;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    gray[i] = seed >>> 24;
  }
  const url = encodeShareLink(validDocument(), {
    width: SHARE_IMAGE_MAX_DIM,
    height: SHARE_IMAGE_MAX_DIM,
    gray,
    scale: 1,
  });
  // Browsers accept far more than this; the limit that matters is what survives
  // being pasted through a chat client, and 16k is the conservative figure.
  //
  // The payload is NOT compressed (see SHARE_IMAGE_MAX_DIM), so this number does
  // not depend on the image's content -- which is why the incompressible fixture
  // above is the real measurement rather than a pessimistic one.
  assert.ok(
    url.length < 16_000,
    `a ${SHARE_IMAGE_MAX_DIM}px image made a ${url.length}-char link`,
  );
});

test('a codec version this build does not know is refused', () => {
  const bytes = encodeDocument(validDocument());
  bytes[0] = 99;
  assert.throws(() => decodeDocument(bytes), /share format 99/);
  // Zero was never a version, so it is not a link at all rather than an old one.
  bytes[0] = 0;
  assert.throws(() => decodeDocument(bytes), /share format 0/);
});


/**
 * A link in the OLD format -- JSON through lz-string under the `#c=` key.
 *
 * Nothing in the app writes one any more, which is exactly why the test file has
 * to: `#c=` links are still read, and the only way to keep proving that is to
 * build one here. Written against the compressor directly rather than by keeping
 * a hardcoded string, so the fixture stays in step with the documents above
 * instead of rotting into a blob nobody can regenerate.
 */
function legacyLink(document: unknown): string {
  return `#c=${LZString.compressToEncodedURIComponent(JSON.stringify(document))}`;
}

/**
 * base64url, duplicated from `shareLink.ts` rather than exported for the test.
 *
 * The only case that needs it is the one below, which has to make a payload the
 * encoder WILL NOT make -- one with a bumped codec version. Widening the
 * module's public API to reach a private helper would make the production
 * surface answer to the tests; six lines here does not.
 */
function bytesToBase64UrlForTest(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- 1. the round trip ------------------------------------------------------

test('a document survives encode/decode byte for byte', () => {
  const doc = validDocument();
  const back = decodeShareLink(encodeShareLink(doc));
  // Byte-exact, not merely equivalent: the whole premise is that a link and a
  // save are the same bytes, so "close enough" is not the claim being made.
  assert.equal(JSON.stringify(back), JSON.stringify(doc));
});

test('the decoded document is still a loadable config', () => {
  // The round trip is only worth anything if what comes out the far end goes
  // through the real reader, which is what actually runs on a shared link.
  const saved = fromDocument(decodeShareLink(encodeShareLink(validDocument())));
  assert.equal(saved.configs.length, 1);
  assert.equal(saved.world.boundaryConditions, BC.WRAP);
  assert.equal(saved.configs[0]!.mutationSeed, 0.82);
});

test('the leading # is optional on the way in', () => {
  const hash = encodeShareLink(validDocument());
  assert.ok(hash.startsWith('#'), 'encode should emit the # so callers concatenate');
  assert.deepEqual(decodeShareLink(hash), decodeShareLink(hash.slice(1)));
});

test('every config survives, not just the first', () => {
  // GUARDS THE OPTIMIZATION NOBODY SHOULD MAKE. `toDocument`'s header records
  // that saving only the selected slot was already removed once on the desktop
  // because it silently dropped the others; a share link that carried config 0
  // alone would reintroduce exactly that, and a single-config fixture would
  // never notice.
  const doc = { ...validDocument(), configs: [0.01, 0.02, 0.03, 0.04].map(oneConfig) };
  const saved = fromDocument(decodeShareLink(encodeShareLink(doc)));
  assert.equal(saved.configs.length, 4);
  // Distinguishable, so a decoder that duplicated one config four times fails.
  // Compared against the float32 values the fixture actually holds rather than
  // the decimals that produced them -- see `oneConfig`. Written as `Math.fround`
  // of the steps rather than as four literals so the intent stays legible: these
  // are the same four numbers, seen at the precision the format has.
  const seconds = saved.configs.map((c) => c.rule[1]);
  assert.deepEqual(seconds, [0.01, 0.02, 0.03, 0.04].map(Math.fround));
});

test('legacy field shapes normalize the way persistence.ts reads them', () => {
  // ENCODE/DECODE IS NOT AN IDENTITY FOR LEGACY FILES, and this pins the three
  // ways it is not so the behaviour is a decision on the record rather than a
  // surprise. Every shipped preset on disk is in exactly this state.
  const legacy = validDocument();
  const config = (legacy['configs'] as Record<string, unknown>[])[0]!;
  // The pre-change float, as every file on disk still holds it.
  (config['force2'] as Record<string, unknown>)['cohort_fences'] = 0.11;
  // The pre-rename block name, which `configFromDocument` still reads.
  config['appearance'] = config['misc2'];
  delete config['misc2'];
  // A block `persistence.ts` deliberately ignores -- see `SavedConfig`.
  legacy['camera'] = { pan: [1, 2], zoom: 3 };

  const back = decodeShareLink(encodeShareLink(legacy)) as Record<string, unknown>;
  const out = (back['configs'] as Record<string, unknown>[])[0]!;

  // The float became the boolean it always meant, exactly as `fencesOr` reads it.
  assert.equal((out['force2'] as Record<string, unknown>)['cohort_fences'], true);
  // `appearance` came back as `misc2`, which is the only name written today.
  assert.equal(out['appearance'], undefined);
  assert.equal(
    (out['misc2'] as Record<string, unknown>)['sensor_distance_jitter'],
    0.16,
    'the renamed block kept its contents',
  );
  // The ignored block is gone rather than carried, and no reader wanted it.
  assert.equal(back['camera'], undefined);

  // THE ASSERTION THAT MAKES THE OTHERS SAFE: normalized or not, what the reader
  // gets out is unchanged. Dropping those keys costs a loaded project nothing.
  const before = fromDocument(legacy, 'before');
  const after = fromDocument(back, 'after');
  assert.deepEqual(after, before);
});

// --- 2. trap 1: the URL must not mangle the payload -------------------------

test('a whole URL round-trips, and the payload has no character needing escaping', () => {
  const doc = validDocument();
  const url = buildShareUrl(LOC, doc);
  const hash = url.slice(url.indexOf('#'));

  assert.equal(JSON.stringify(decodeShareLink(hash)), JSON.stringify(doc));

  // THE REGRESSION THIS EXISTS FOR, restated for the binary payload. The old
  // one CONTAINED `+` and the trap was that `URLSearchParams` turns it into a
  // space; base64url avoids the character entirely, so the assertion becomes
  // the stronger one -- the alphabet itself is safe, rather than merely handled
  // carefully. `+`, `/` and `=` are all absent by construction.
  const payload = hash.slice(3);
  assert.match(payload, /^[A-Za-z0-9_-]+$/, 'base64url only, so nothing needs escaping');

  // The property that actually matters, asserted directly: routing the payload
  // through the class `main.ts` uses for the query string must not change it.
  // This is what would silently break if base64 were ever swapped for base64url.
  const viaSearchParams = new URLSearchParams(hash.slice(1)).get('b');
  assert.equal(viaSearchParams, payload, 'base64url must survive URLSearchParams intact');
});

test('the legacy #c= payload, which contains "+", is still corrupted by URLSearchParams', () => {
  // KEPT AS A LIVE DEMONSTRATION rather than a comment, because `#c=` links are
  // still READ (see `SHARE_HASH_KEY`) and the trap still applies to them. If the
  // legacy path is ever re-plumbed through `URLSearchParams`, this fails.
  const legacy = legacyLink(validDocument());
  const payload = legacy.slice(3);
  assert.ok(payload.includes('+'), 'fixture must exercise the "+" case to be worth anything');
  assert.notEqual(
    new URLSearchParams(legacy.slice(1)).get('c'),
    payload,
    'URLSearchParams corrupts the legacy payload',
  );
});

test('the URL keeps the origin, path and query', () => {
  const url = buildShareUrl({ ...LOC, search: '?debug' }, validDocument());
  assert.ok(url.startsWith('https://example.github.io/Fluoddity2/?debug#b='));
  // Dropping the query would hand the recipient a different app than the one
  // the sharer was looking at.
  assert.ok(url.includes('?debug#'));
});

test('an empty query produces no stray "?"', () => {
  const url = buildShareUrl(LOC, validDocument());
  assert.ok(!url.includes('?'), url.slice(0, 60));
});

// --- 2b. what actually lands on a clipboard ---------------------------------

test('decodeShareText accepts every shape a paste really arrives in', () => {
  const doc = validDocument();
  const url = buildShareUrl(LOC, doc);
  const hash = url.slice(url.indexOf('#'));
  const bare = hash.slice(1); // `b=...`, from a selection that missed the `#`

  const want = JSON.stringify(doc);
  const shapes: Record<string, string> = {
    'a whole URL': url,
    'just the fragment': hash,
    'the fragment without its #': bare,
    'wrapped in whitespace': `  ${url}\n`,
    // What a mail client that hard-wraps at 78 columns does to a long link.
    // base64url contains no whitespace, so anything matching this is damage
    // from transit and can be safely removed.
    'broken across lines': `${url.slice(0, 78)}\n${url.slice(78)}`,
    'angle-bracketed, as mail clients do': `<${url}>`.replace(/[<>]/g, ''),
    // The compatibility path, carried through the same shapes: an old link
    // pasted from a chat history is the case this whole key split exists for.
    'a legacy #c= link': legacyLink(doc),
    'a legacy link wrapped in whitespace': `\n  ${legacyLink(doc)}  `,
  };

  for (const [shape, text] of Object.entries(shapes)) {
    assert.equal(JSON.stringify(decodeShareText(text)), want, shape);
  }
});

test('decodeShareText says "not ours" rather than "damaged" for ordinary text', () => {
  // What someone has on their clipboard when they press Shift+V by accident.
  // Each must be a quiet no, not an error about a corrupt link.
  for (const text of ['', '   ', 'hello world', 'https://example.com/', 'https://example.com/#about']) {
    assert.equal(decodeShareText(text), null, JSON.stringify(text));
  }
});

test('decodeShareText still rejects a damaged payload', () => {
  const url = buildShareUrl(LOC, validDocument());
  assert.throws(() => decodeShareText(url.slice(0, url.length - 400)), ShareLinkError);
});

// --- 3. fragments that are not ours -----------------------------------------

test('a fragment without our key is not ours, and is not an error', () => {
  // Every one of these is a real thing a browser or a copied link can produce.
  // Reporting any of them as a damaged share link would blame us for someone
  // else's anchor.
  for (const hash of ['', '#', '#about', '#section-2', '#c', '#config=x', '#cc=x']) {
    assert.equal(decodeShareLink(hash), null, `expected null for ${JSON.stringify(hash)}`);
  }
});

// --- 4. trap 2: ours, but broken --------------------------------------------

test('a truncated payload is reported, not silently ignored', () => {
  // THE COMMONEST REAL FAILURE. The binary payload declares its config count in
  // the header, so a short one is caught by the length check rather than by
  // running off the end of the `DataView` -- but the USER-VISIBLE behaviour is
  // the assertion, and it is the same either way: an error, never a silent
  // no-op. Every cut point is tried, because a decoder that only checked the
  // total length would pass a truncation that lands on a config boundary.
  const payload = encodeShareLink(validDocument()).slice(3);
  for (const frac of [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
    const cut = Math.floor(payload.length * frac);
    assert.throws(
      () => decodeShareLink(`#b=${payload.slice(0, cut)}`),
      ShareLinkError,
      `truncated at ${Math.round(frac * 100)}%`,
    );
  }
});

test('a truncated LEGACY payload is still reported', () => {
  // Trap 2 in its original form: decompressing half a payload returns `''`
  // rather than raising, so without the explicit empty check the old path would
  // load nothing and say nothing. Still live, so still tested.
  const payload = legacyLink(validDocument()).slice(3);
  const truncated = `#c=${payload.slice(0, Math.floor(payload.length / 2))}`;
  assert.throws(() => decodeShareLink(truncated), ShareLinkError);
});

test('our key with an empty or unreadable payload throws', () => {
  for (const hash of ['#b=', '#b=!!!not-a-payload!!!', '#b=A', '#c=', '#c=!!!not-a-payload!!!']) {
    assert.throws(() => decodeShareLink(hash), ShareLinkError, hash);
  }
});

test('a link from a NEWER codec says so, rather than calling itself damaged', () => {
  // The bytes are well-formed; only the codec version is unknown. The user's
  // remedy is to update the page, not to ask for a fresh copy of the link, so
  // the message has to distinguish the two -- and `shareLink` must pass the
  // codec's wording through rather than flattening it into "damaged".
  const bytes = encodeDocument(validDocument());
  bytes[0] = CODEC_VERSION + 1;
  const hash = `#b=${bytesToBase64UrlForTest(bytes)}`;
  assert.throws(() => decodeShareLink(hash), {
    name: 'ShareLinkError',
    message: /share format|updating/,
  });
});

// --- 5. the layering --------------------------------------------------------

test('a document with no configs decodes here and is rejected by the reader', () => {
  // REPLACES AN OLDER CASE that encoded the number `42`. That worked when the
  // payload was JSON, which can carry any value; a typed codec cannot represent
  // a bare number, and pretending otherwise would test a shape the app can never
  // produce. The POINT of that case survives intact, though, and it is the point
  // that matters: this layer does not get an opinion about meaning. An empty
  // `configs` list is a real document, decodes here without complaint, and is
  // refused by `fromDocument` -- which is where the refusing belongs.
  const hash = encodeShareLink({ ...validDocument(), configs: [] });
  const doc = decodeShareLink(hash) as Record<string, unknown>;
  assert.deepEqual(doc['configs'], []);
  assert.throws(() => fromDocument(doc, 'shared link'), ConfigFormatError);
});

test('a future version decodes here and is rejected by the reader', () => {
  // NOT A VERSION CHECK IN THIS FILE. Transport does not get an opinion about
  // meaning; `fromDocument` is the one interpreter and gives the message that
  // actually says what is wrong.
  const hash = encodeShareLink({ ...validDocument(), version: 9 });
  const doc = decodeShareLink(hash);
  assert.equal((doc as Record<string, unknown>)['version'], 9);
  assert.throws(() => fromDocument(doc, 'shared link'), {
    name: 'ConfigFormatError',
    message: /shared link.*version 9/,
  });
});

// --- 6. the shipped presets -------------------------------------------------

test('a real shipped preset round-trips and stays comfortably short', () => {
  // WHICHEVER PRESET IS THERE, never one by name. The shipped library turns
  // over constantly -- presets are swapped in and out as the interesting ones
  // change -- and a test that names one breaks on a library edit for a reason
  // that has nothing to do with share links. `npm run sync:configs` is the
  // definitive list; this just takes the first thing off disk.
  const dir = path.join(REPO_ROOT, 'configs');
  const first = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()[0];
  // Guards against a vacuous pass if `configs/` is ever empty or moved.
  assert.ok(first !== undefined, `no presets found in ${dir}`);

  const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, first), 'utf8'));

  // ROUND-TRIPPED AS THE APP WOULD SHARE IT, which means through `toDocument`
  // first. A file on disk is NOT the right input here: the shipped presets still
  // carry a `camera` block and a float `cohort_fences`, both of which
  // `persistence.ts` reads tolerantly and neither of which it writes. The codec
  // emits what `toDocument` emits, so comparing against the raw file would be
  // asserting that a normalizing round trip is an identity one -- see
  // `shareCodec.ts`'s header.
  const saved = fromDocument(raw, first);
  const doc = toDocument(saved.configs, saved.world, saved.notes);
  const hash = encodeShareLink(doc);

  assert.equal(JSON.stringify(decodeShareLink(hash)), JSON.stringify(doc));

  // PINS THE MEASUREMENT the warning threshold was chosen against (~530
  // characters for a one-config project, down from ~1800). If the format grows
  // enough to put a typical preset near the threshold, that is a decision to
  // make deliberately rather than to discover from a user whose link got cut in
  // half. The bound is deliberately loose -- it is a smoke alarm, not a
  // golden-size assertion that fails on every incidental change.
  assert.ok(
    hash.length < 900,
    `${first} encoded to ${hash.length} chars; the threshold is ${SHARE_LINK_WARN_LENGTH}`,
  );
});

// --- 7. the whole shipped library, byte for byte ----------------------------

test('every shipped config survives the codec byte for byte', () => {
  // THE CLAIM THE BINARY FORMAT LIVES OR DIES BY, checked against real data
  // rather than a fixture. A hand-written document exercises whatever the author
  // thought of; the shipped library exercises what the app actually produces --
  // and it is where the trap that dictated the float widths was found.
  //
  // NOT EVERY NUMBER IN A SAVED DOCUMENT IS FLOAT32: `mutation_seed` is float64
  // in almost every preset, because it comes from a UI slider rather than off
  // the GPU. Storing it as float32 would round it, and it is fed to a chaotic
  // hash -- so the link would open a DIFFERENT RULE that still looked entirely
  // legitimate. That is the failure this test exists to prevent, and it is
  // invisible to any assertion weaker than byte equality.
  const roots = [path.join(REPO_ROOT, 'configs'), path.join(REPO_ROOT, 'configs', 'Archive')];
  let checked = 0;

  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const saved = fromDocument(raw, file);
      const doc = toDocument(saved.configs, saved.world, saved.notes);

      assert.equal(
        JSON.stringify(decodeShareLink(encodeShareLink(doc))),
        JSON.stringify(doc),
        `${file} did not survive the round trip byte for byte`,
      );
      checked += 1;
    }
  }

  // Guards against a vacuous pass if `configs/` is ever emptied or moved.
  assert.ok(checked > 20, `expected the shipped library, found ${checked} files`);
});
