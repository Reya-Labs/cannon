#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const bundleDirectory = process.argv[2];
if (!bundleDirectory) {
  throw new Error('registry bundle path is required');
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const forbiddenMarkers = [
  '@aws-sdk/client-s3',
  '@google-cloud/storage',
  '@usecannon/cli',
  '@usecannon/repo',
  'ARTIFACT_SOURCE_URL',
  'ARTIFACT_WRITER_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'GCS_PROJECT_ID',
  'S3_ENDPOINT',
  'S3_SECRET',
  'createArtifactFacadeClient',
  'getS3Client',
  'mirrorArtifactClosure',
  'startPinningWorker',
];
const found = [];
const bundleFiles = filesUnder(bundleDirectory);
const relativeFiles = bundleFiles
  .map((file) => path.relative(bundleDirectory, file).split(path.sep).join('/'))
  .sort();
const expectedFiles = ['index.js', 'rabin.wasm'];
if (JSON.stringify(relativeFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    `registry bundle contains unexpected files: ${relativeFiles.join(', ')}`
  );
}

for (const file of bundleFiles) {
  const contents = fs.readFileSync(file);
  if (contents.includes(0)) continue;
  const text = contents.toString('utf8');
  for (const marker of forbiddenMarkers) {
    if (text.includes(marker)) found.push(`${marker} in ${file}`);
  }
}

if (found.length) {
  throw new Error(
    `registry bundle contains worker or object-store code: ${found.join(', ')}`
  );
}
