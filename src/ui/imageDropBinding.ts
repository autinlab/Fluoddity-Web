/**
 * Drag-and-drop for the density image: the DOM half.
 *
 * The listener layer, mirroring `inputBinding.ts`. It holds no rules -- which
 * file to take, whether it can be decoded and how to name it all live in
 * `imageDrop.ts`, which is pure and tested. What is here is what genuinely
 * cannot be: four listeners, a decode, and an overlay element.
 *
 * ## LISTENERS GO ON THE DOCUMENT, NOT THE CANVAS
 *
 * A drop that MISSES the canvas -- landing on the Tweakpane panel, or on a
 * letterbox bar -- is still a drop the user meant, and if this module has not
 * called `preventDefault` on it the browser NAVIGATES AWAY to display the image
 * file. That loses the session: the simulation, the project, the undo history.
 * Binding at the document level is the only way to catch it, and it is why
 * `dragover` is cancelled unconditionally rather than only over the canvas.
 *
 * This is the one place `ui/`'s "the canvas owns canvas input" rule does not
 * apply, and deliberately: the failure it prevents is not a misrouted event but
 * a lost page.
 *
 * ## THE DRAG COUNTER
 *
 * `dragleave` fires when the cursor crosses into a CHILD element, not only when
 * it leaves the window, so hiding the overlay on every `dragleave` makes it
 * flicker as the cursor moves over the panel. The depth counter is the standard
 * fix and the reason this is not three lines.
 */

import {
  chooseDroppedImage,
  displayName,
  rejectionMessage,
} from './imageDrop.ts';
import type { RgbaImage } from '../share/qrRender.ts';

/**
 * Longest edge the decoded bitmap is allowed to have before the gradient is
 * built from it.
 *
 * The gradient chain (`densityGradient.ts`) is plain JavaScript over every
 * pixel, so a 6000x6000 figure would be 36 million pixels through a luminance
 * pass and an area resample on the main thread -- a visible stall on a drop.
 * `createImageBitmap` can downscale during DECODE using the browser's own
 * optimized path, so the cap costs nothing and bounds the work.
 *
 * 2048 is comfortably above the density field's own 1024-texel cap, so the
 * resample that follows is still a downscale and no detail is invented. Raising
 * this would not sharpen the field; it is already finer than the texture.
 */
export const MAX_DECODE_DIM = 2048;

export interface ImageDropCallbacks {
  /** A decoded image, ready for `loadDensityImage`. */
  readonly onImage: (image: RgbaImage, name: string) => void;
  /** Something went wrong, or the drop held nothing usable. */
  readonly onError: (message: string) => void;
}

/** Decode a file to plain RGBA bytes, downscaling large ones during decode. */
async function decodeImage(file: File): Promise<RgbaImage> {
  // Measured first so the aspect is preserved: passing only resizeWidth would
  // stretch anything that was already within the cap on the other axis.
  const probe = await createImageBitmap(file);
  const longest = Math.max(probe.width, probe.height);
  let bitmap = probe;
  if (longest > MAX_DECODE_DIM) {
    const scale = MAX_DECODE_DIM / longest;
    bitmap = await createImageBitmap(file, {
      resizeWidth: Math.max(1, Math.round(probe.width * scale)),
      resizeHeight: Math.max(1, Math.round(probe.height * scale)),
      // 'high' rather than the default: this is a downscale, where the default
      // can point-sample and alias noise straight through into the gradient --
      // the same failure `resampleArea` exists to avoid one stage later.
      resizeQuality: 'high',
    });
    probe.close();
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2D context available to read the image');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const image: RgbaImage = {
    width: bitmap.width,
    height: bitmap.height,
    data: data.data,
  };
  // Bitmaps hold decoded pixels outside the JS heap, so they are not reclaimed
  // by dropping the reference -- the same argument `destroy()` makes for GPU
  // textures. Dropping a few large images without this grows memory for the
  // rest of the session.
  bitmap.close();
  return image;
}

/** The "drop an image" overlay. Built once, shown while a drag is in flight. */
function createOverlay(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'image-drop-overlay';
  el.style.cssText =
    'position:fixed;inset:0;z-index:20;display:none;pointer-events:none;' +
    'align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,.45);backdrop-filter:blur(2px);' +
    'font:600 15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#fff;';
  const label = document.createElement('div');
  label.style.cssText =
    'padding:18px 26px;border:2px dashed rgba(255,255,255,.7);border-radius:10px;' +
    'background:rgba(0,0,0,.35);text-align:center;';
  label.textContent = 'Drop a density image';
  const hint = document.createElement('div');
  hint.style.cssText = 'margin-top:6px;font-weight:400;opacity:.75;font-size:13px;';
  hint.textContent = 'PNG, JPEG or WebP';
  label.append(hint);
  el.append(label);
  document.body.append(el);
  return el;
}

/**
 * Install the listeners. Returns a teardown for symmetry with `bindInput`.
 */
export function bindImageDrop(callbacks: ImageDropCallbacks): () => void {
  const overlay = createOverlay();
  let depth = 0;

  const show = (): void => {
    overlay.style.display = 'flex';
  };
  const hide = (): void => {
    depth = 0;
    overlay.style.display = 'none';
  };

  /** Whether this drag carries files at all, so a text selection is ignored. */
  const carriesFiles = (ev: DragEvent): boolean =>
    ev.dataTransfer !== null && [...ev.dataTransfer.types].includes('Files');

  const onDragEnter = (ev: DragEvent): void => {
    if (!carriesFiles(ev)) return;
    depth += 1;
    show();
  };

  const onDragOver = (ev: DragEvent): void => {
    if (!carriesFiles(ev)) return;
    // UNCONDITIONAL, and this is the load-bearing line of the file: without it
    // the browser handles the drop itself and navigates away from the app.
    ev.preventDefault();
    if (ev.dataTransfer !== null) ev.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (ev: DragEvent): void => {
    if (!carriesFiles(ev)) return;
    depth -= 1;
    if (depth <= 0) hide();
  };

  const onDrop = (ev: DragEvent): void => {
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    hide();

    const files = [...(ev.dataTransfer?.files ?? [])];
    const { file, rejection } = chooseDroppedImage(files);
    if (file === null) {
      // `rejection` is non-null whenever `file` is null -- the two are one
      // decision in `chooseDroppedImage`. Guarded anyway because the compiler
      // cannot see that through the union, and a thrown TypeError inside a drop
      // handler would leave the overlay's state ambiguous.
      callbacks.onError(
        rejection === null ? 'Nothing to load' : rejectionMessage(rejection),
      );
      return;
    }

    // Async, and the handler does NOT await: a drop handler that returns a
    // promise still ends the browser's drag interaction, so the work continues
    // after the gesture is over and reports through the callbacks.
    void decodeImage(file)
      .then((image) => {
        callbacks.onImage(image, displayName(file.name));
      })
      .catch((error: unknown) => {
        // A file that passed the type check can still fail to decode -- a
        // truncated download, or a PNG that is really something else. The name
        // is included because by now the overlay is gone and there is nothing
        // else on screen tying the message to what was dropped.
        const detail = error instanceof Error ? error.message : String(error);
        callbacks.onError(`Could not read ${displayName(file.name)}: ${detail}`);
      });
  };

  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);

  return () => {
    document.removeEventListener('dragenter', onDragEnter);
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('dragleave', onDragLeave);
    document.removeEventListener('drop', onDrop);
    overlay.remove();
  };
}
