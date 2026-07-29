#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  encodeSourceBundle,
  SOURCE_ROOT,
} from '../../packages/source-gateway/dist/bundle.js';
import { createReyaReadOnlyClients } from '../../packages/reya-safe-ui/src/clients/index.mjs';

const commit = '2b10669075b91eb8db781d199292f30c52f8e994';
const firstIncludePath = 'packages/tomls/src/omnibus/z.toml';
const secondIncludePath = 'packages/tomls/src/omnibus/a.toml';
const encoded = encodeSourceBundle(
  commit,
  new Map([
    [SOURCE_ROOT, 'include = ["z.toml", "a.toml"]\nversion = "1"\n'],
    [firstIncludePath, '[var]\nvalue = "1"\n'],
    [secondIncludePath, '[var]\nvalue = "2"\n'],
  ])
);
const client = createReyaReadOnlyClients({
  fetchImpl: async () =>
    new Response(encoded.body, {
      headers: { 'content-type': 'application/json' },
    }),
  serviceOrigin: 'https://cannon-api.reya-tailnet.ts.net',
  verifyAbiSelector: async () => true,
  verifyArtifactCid: async () => '',
});

const bundle = await client.source.bundle({ commit });

assert.equal(bundle.bundleSha256, encoded.bundle.bundleSha256);
assert.deepEqual(
  bundle.files.map(({ path }) => path),
  [secondIncludePath, SOURCE_ROOT, firstIncludePath],
  'the signed wire representation must remain path-sorted'
);
assert.deepEqual(
  bundle.orderedFiles.map(({ path }) => path),
  [SOURCE_ROOT, firstIncludePath, secondIncludePath],
  'the adapter representation must preserve declared include order'
);

console.log('Source gateway and Reya Safe UI contract vector passed.');
