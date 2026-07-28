import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const exported = {};
const context = vm.createContext({
  Array,
  ArrayBuffer,
  BigInt,
  Blob,
  CustomEvent,
  DataView,
  Error,
  Event,
  EventTarget,
  JSON,
  Math,
  Object,
  Promise,
  String,
  Symbol,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  WebAssembly,
  crypto: webcrypto,
  exports: exported,
  module: { exports: exported },
  queueMicrotask,
  setTimeout,
});

const source = await readFile(
  new URL('../dist/index.js', import.meta.url),
  'utf8'
);
new vm.Script(source, { filename: 'artifact-codec.browser.cjs' }).runInContext(
  context
);

const cid = await exported.getContentCID(
  new TextEncoder().encode('hello world')
);
if (cid !== 'Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD') {
  throw new Error(`browser bundle CID mismatch: ${cid}`);
}

for (const [value, expectedCid] of [
  [
    'Cannon CID 🚀 — こんにちは',
    'QmZ2e7ad1h24r4jpKtV9BCDFEuig9BgpMqkfuGywboXdcs',
  ],
  ['\ud800', 'QmTFs8cxGDXJL7FqWKfAbveU3KQQMPgf3TFwuVdQmVPTv8'],
]) {
  const stringCid = await exported.getContentCID(value);
  if (stringCid !== expectedCid) {
    throw new Error(`browser bundle string CID mismatch: ${stringCid}`);
  }
}

const compressed = exported.compress('browser artifact');
if (exported.uncompress(compressed) !== 'browser artifact') {
  throw new Error('browser bundle compression round trip failed');
}

console.log('artifact codec browser bundle verified without Node globals');
