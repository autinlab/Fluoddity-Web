/**
 * The Project section: live controls over everything a save file contains.
 *
 * The port of `ui/settings_window.py`'s body (`:72-126`). **The project** is the
 * state the save/load system stores and restores: the whole ConfigBuffer plus
 * the world settings -- so this section renders `CONFIG` and `WORLD` and
 * nothing else. Editor preferences are a different KIND of state and live in
 * `preferencesSection.ts`, together with the Basic/Advanced toggle that governs
 * both.
 *
 * Controls are grouped into collapsible folders by their `group`, and **a group
 * whose members are all hidden by the current tier is not rendered at all** --
 * `grouped()` omits it, which is how the Trails and Advanced folders vanish in
 * Basic mode rather than showing empty headers.
 *
 * ## No undo here, on purpose
 *
 * The config clipboard already snapshots and restores the whole buffer, so
 * "checkpoint, experiment, hover to A/B, click to revert" is the undo story
 * (`settings_window.py:24-27`). The Revert button (10e) is the coarser version:
 * back to what storage holds, discarding everything since.
 *
 * Values are pushed on every change, straight into the GPU buffer -- editing a
 * slider shows its effect immediately, which is the point of having sliders at
 * all rather than editing JSON.
 */

import type { FolderApi } from 'tweakpane';
import type { Status } from '../../orchestrator/commands.ts';
import { type ControlBinding, addControl } from '../controls.ts';
import { CONFIG, WORLD, grouped } from '../settingsSpec.ts';
import { addAdvancedToggle } from '../advancedToggle.ts';
import { type SectionContext, type SectionHandle, bindingsOnly } from './section.ts';

/**
 * The folder header, naming the project the controls below are editing.
 *
 * The panel writes a static `'Project'` from `panelModel.ts`; this section
 * replaces it with the live name on every refresh, because the name changes
 * under the panel -- a load, a save-as, a clipboard restore -- and a header
 * still reading the previous project is the exact confusion `project.ts:17-20`
 * describes.
 */
function projectTitle(name: string): string {
  return `Project: ${name}`;
}

export function buildProjectSection(
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
): SectionHandle {
  const bindings: ControlBinding[] = [];

  folder.title = projectTitle(status.projectName);

  // ON THE TITLE BUTTON, not the folder element. A folder's `element` wraps the
  // header AND its contents, so attaching there would fire the tooltip over
  // every control inside -- each of which has its own help and would be
  // shadowed by this one. The header is the folder's own direct child button,
  // which is the same node `hideFolderTitle` reaches for in
  // `settingsSection.ts`; if it is ever missing there is nothing to describe
  // and doing nothing is correct.
  const header = (folder.element as HTMLElement).querySelector(':scope > button');
  if (header !== null) {
    ctx.tooltip.attach(header as HTMLElement, {
      title: 'Project',
      body:
        'All settings on the project panel are covered by File->Save/Load, ' +
        'project urls, and the checkpoint system',
    });
  }

  // FIRST, above the groups it governs. Tweakpane appends, so build order is
  // display order. This panel's tier only -- the other two answer for
  // themselves (`advancedToggle.ts`).
  addAdvancedToggle(folder, 'advancedProject', ctx);

  /**
   * Per-frame work the group folders added beyond their controls.
   *
   * Only the Density Image folder has any, and it is a readout rather than a
   * binding -- `bindingsOnly` would have nothing to do with it.
   */
  const extras: ((s: Status) => void)[] = [];

  for (const [group, settings] of grouped(ctx.advanced, [CONFIG, WORLD])) {
    // `group` is never empty for these entries -- every CONFIG/WORLD setting
    // declares one -- but the fallback keeps a future ungrouped entry from
    // producing a folder with no title rather than crashing.
    const sub = folder.addFolder({ title: group || 'Settings', expanded: true });
    (sub.element as HTMLElement).dataset['group'] = group;
    for (const setting of settings) {
      bindings.push(addControl(sub, setting, status, ctx));
    }
    if (group === DENSITY_GROUP) {
      extras.push(addDensityImageRow(sub, status, ctx));
    }
  }

  // Wraps `bindingsOnly` rather than replacing it: the controls refresh exactly
  // as every other section's do, and this only adds the header on top.
  //
  // Written on an actual change, not every frame. Tweakpane's title setter
  // touches the DOM, and this runs once per frame for a string that changes on
  // a load or a save -- the same instinct as `panel.ts`'s `setHidden`.
  const base = bindingsOnly(bindings);
  let shown = folder.title;
  return {
    bindings: base.bindings,
    refresh: (s, input) => {
      const title = projectTitle(s.projectName);
      if (title !== shown) {
        shown = title;
        folder.title = title;
      }
      base.refresh(s, input);
      for (const extra of extras) extra(s);
    },
  };
}

/**
 * The `group` the density controls declare. Matched rather than hardcoded twice.
 */
const DENSITY_GROUP = 'Density Image';

/** What the readout says with nothing dropped. */
const NO_IMAGE = '(drop an image)';

/**
 * The Density Image folder's two non-slider rows: which image is loaded, and a
 * way to remove it.
 *
 * ## WHY THE READOUT EXISTS
 *
 * The three sliders do nothing at all until an image is dropped, and there is
 * otherwise NOTHING on screen that says whether one is. A user who drops a file
 * the browser cannot decode gets a toast that has since faded, then three
 * controls that appear broken. This row is the answer to "is it loaded?", which
 * is the first question the feature raises.
 *
 * ## WHY CLEAR IS HERE AND NOT ONLY A HOTKEY
 *
 * Dropping is the only way in, and without this there was no way OUT -- the image
 * would persist for the session with no affordance to remove it. Labelled "not
 * undoable" for the same reason `Clear Field` is: the image is live-only state
 * that History was never designed to hold.
 *
 * Returns a per-frame updater rather than a `SectionHandle`: this owns no
 * `ControlBinding`, because a readonly monitor is not a control the tier system
 * or the gating system has anything to say about.
 */
function addDensityImageRow(
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
): (s: Status) => void {
  const proxy = { image: status.densityImageName || NO_IMAGE };
  const readout = folder.addBinding(proxy, 'image', {
    readonly: true,
    label: 'Loaded',
  });

  const clear = folder.addButton({ title: 'Clear Image (not undoable)' });
  clear.on('click', () => {
    ctx.send({ kind: 'clearDensityImage' });
  });
  ctx.tooltip.attach(clear.element as HTMLElement, {
    title: 'Clear Image',
    body:
      'Forget the dropped density image. The three strength sliders keep their ' +
      'values and are saved with the project; the image itself never is.',
  });

  // WRITTEN ON AN ACTUAL CHANGE, not every frame -- `refresh()` touches the DOM,
  // and this runs at 60fps for a string that changes when a file is dropped.
  // Same instinct as the folder title above.
  let shown = proxy.image;
  return (s) => {
    const next = s.densityImageName || NO_IMAGE;
    if (next === shown) return;
    shown = next;
    proxy.image = next;
    // No `isRefreshing` guard needed here and deliberately none added: a
    // readonly monitor dispatches nothing, so there is no feedback loop for one
    // to break. Adding a guard anyway would suggest there is.
    readout.refresh();
  };
}
