import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseDroppedImage,
  displayName,
  isDecodableImage,
  rejectionMessage,
} from './imageDrop.ts';

const png = { name: 'cryoET.png', type: 'image/png' };
const junk = { name: '.DS_Store', type: '' };
const tiff = { name: 'tomogram.tif', type: 'image/tiff' };

test('the decodable formats are accepted and TIFF is not', () => {
  assert.ok(isDecodableImage(png));
  assert.ok(isDecodableImage({ name: 'a.jpg', type: 'image/jpeg' }));
  assert.ok(isDecodableImage({ name: 'a.webp', type: 'image/webp' }));
  // No browser decodes TIFF natively, so accepting it would fail later with a
  // worse message. The refusal is the feature.
  assert.ok(!isDecodableImage(tiff));
  assert.ok(!isDecodableImage({ name: 'notes.txt', type: 'text/plain' }));
});

test('a missing MIME type falls back to the extension', () => {
  // Some file managers and archive viewers supply no type at all.
  assert.ok(isDecodableImage({ name: 'slice.PNG', type: '' }));
  assert.ok(!isDecodableImage({ name: 'slice.tif', type: '' }));
  assert.ok(!isDecodableImage(junk));
});

test('a non-empty MIME type is NOT overridden by the extension', () => {
  // A browser saying `image/tiff` means it, so the extension must not rescue a
  // type that was actually supplied -- otherwise `a.png` mislabelled as TIFF
  // would be accepted and then fail to decode.
  assert.ok(!isDecodableImage({ name: 'mislabelled.png', type: 'image/tiff' }));
});

test('the image is chosen by TYPE, not by position in the drop', () => {
  // THE CASE THAT MATTERS: macOS routinely puts metadata first. Taking files[0]
  // would load nothing here and say nothing about why.
  const choice = chooseDroppedImage([junk, png]);
  assert.equal(choice.file, png);
  assert.equal(choice.rejection, null);
});

test('an empty drop and an undecodable drop are told apart', () => {
  assert.deepEqual(chooseDroppedImage([]).rejection, { reason: 'empty' });
  assert.deepEqual(chooseDroppedImage([tiff]).rejection, {
    reason: 'undecodable',
    name: 'tomogram.tif',
  });
});

test('the rejection message names the file and the remedy', () => {
  const message = rejectionMessage({ reason: 'undecodable', name: 'tomogram.tif' });
  assert.match(message, /tomogram\.tif/);
  assert.match(message, /PNG/);
});

test('a long name keeps its tail, where the identifying part lives', () => {
  const long = 'tomogram_20240115_run3_slice_042.png';
  const short = displayName(long);
  assert.ok(short.length <= 28, `${short} is ${short.length} chars`);
  // The extension and the slice number survive -- a plain truncation would keep
  // "tomogram_2024011..." and drop everything that tells two files apart.
  assert.ok(short.endsWith('042.png'), short);
  assert.ok(short.startsWith('tomogram'), short);
  assert.ok(short.includes('…'), 'the elision must be visible');
});

test('a short name is returned untouched', () => {
  assert.equal(displayName('cryoET.png'), 'cryoET.png');
});
