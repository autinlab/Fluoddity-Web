/**
 * What a dropped file means -- the decidable half of image drag-and-drop.
 *
 * PURE, and split from `imageDropBinding.ts` for exactly the reason
 * `inputTracker.ts` is split from `inputBinding.ts`: `node --test` has no DOM,
 * no `DataTransfer` and no `createImageBitmap`, so everything that DECIDES
 * anything lives here and the listener layer holds no rules of its own.
 *
 * The decisions look trivial and are not. Each of the three below has a failure
 * mode that is silent or actively misleading:
 *
 *   * A drop with several files, or with a folder, has to pick one -- and
 *     picking by index rather than by type means dropping a screenshot next to a
 *     `.DS_Store` loads nothing and says nothing.
 *   * A `.tif` from a microscope has a MIME type browsers do not agree on, and
 *     `createImageBitmap` cannot decode it anyway. Rejecting it with the reason
 *     is the difference between "this app is broken" and "convert to PNG".
 *   * A long filename in a 320px panel truncates in the middle of the name,
 *     where the distinguishing part usually is.
 */

/** The subset of `File` this module needs. Narrow so tests need no DOM. */
export interface DroppedFile {
  readonly name: string;
  /** The MIME type, or `''` when the OS gave the browser nothing. */
  readonly type: string;
}

/**
 * Formats `createImageBitmap` can actually decode, and browsers agree on.
 *
 * TIFF IS DELIBERATELY ABSENT even though it is what a microscope writes, and
 * that is worth stating rather than leaving as an oversight: no browser decodes
 * TIFF natively, so accepting it would mean shipping a decoder. A user with a
 * tomogram slice exports a PNG, which loses nothing this feature uses -- the
 * gradient is built from luminance, and a 16-bit TIFF's extra depth is discarded
 * by the contrast stretch anyway.
 */
const DECODABLE = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'] as const;

/** Extensions to fall back on when the OS supplied no MIME type. */
const DECODABLE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] as const;

/** Why a drop was refused, or `null` if it was not. */
export type DropRejection =
  | { readonly reason: 'empty' }
  | { readonly reason: 'undecodable'; readonly name: string };

export interface DropChoice<T extends DroppedFile> {
  readonly file: T | null;
  readonly rejection: DropRejection | null;
}

/** Whether this file is one the browser can turn into pixels. */
export function isDecodableImage(file: DroppedFile): boolean {
  if (DECODABLE.some((t) => t === file.type)) return true;
  // A type of '' happens with some file managers and with drops out of archive
  // viewers. Falling back to the extension is what makes those work; falling
  // back for a NON-empty type would not, because a browser that says
  // `image/tiff` means it.
  if (file.type !== '') return false;
  const lower = file.name.toLowerCase();
  return DECODABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Pick the image to load from everything that was dropped.
 *
 * BY TYPE, NOT BY POSITION. Selecting `files[0]` means a multi-file drop, or one
 * where the OS puts a metadata file first, silently loads the wrong thing or
 * nothing. The first DECODABLE file is the one the user meant in every case
 * where there is exactly one image, which is nearly all of them.
 *
 * The rejection is returned rather than thrown: a bad drop is ordinary user
 * input, not an exception, and the caller needs the reason to put in the toast.
 */
export function chooseDroppedImage<T extends DroppedFile>(files: readonly T[]): DropChoice<T> {
  if (files.length === 0) {
    return { file: null, rejection: { reason: 'empty' } };
  }
  const image = files.find(isDecodableImage);
  if (image === undefined) {
    // Names the FIRST file rather than counting them: with one file that is the
    // thing the user dropped, and with several the first is what they aimed at.
    return { file: null, rejection: { reason: 'undecodable', name: files[0]!.name } };
  }
  return { file: image, rejection: null };
}

/** The message for a refused drop. One place, so the two callers cannot differ. */
export function rejectionMessage(rejection: DropRejection): string {
  if (rejection.reason === 'empty') {
    return 'Nothing to load - drop an image file';
  }
  return `Cannot read ${displayName(rejection.name)} - use PNG, JPEG or WebP`;
}

/**
 * A filename shortened for the status line.
 *
 * The EXTENSION AND THE TAIL ARE KEPT, and the middle is elided. A plain
 * `slice(0, n)` keeps the least distinguishing part: scientific filenames are
 * routinely `tomogram_20240115_run3_slice_042.png`, where everything that
 * identifies it is at the end.
 */
export function displayName(name: string, max = 28): string {
  if (name.length <= max) return name;
  // Split the budget with the tail favoured, minus one for the ellipsis.
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}
