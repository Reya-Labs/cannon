import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { getContentCID } = require('../dist/index.js');

const KUBO_VERSION = '0.39.0';
const KUBO_PLATFORM = 'darwin-arm64';
const KUBO_RELEASE_ARCHIVE_SHA512 =
  '229c4307d16fdab54ab35e2ba6f1a71c44349b750d7817fefeb4fed804a9a629176becf8a7ec83a791c8ba90ff6e649d3fb9b65d1b96334c134f853aa27d7b56';
const kuboArchive = process.env.KUBO_ARCHIVE;

if (!kuboArchive) {
  throw new Error(
    `Set KUBO_ARCHIVE to the official kubo_v${KUBO_VERSION}_${KUBO_PLATFORM}.tar.gz release archive`
  );
}

if (`${process.platform}-${process.arch}` !== KUBO_PLATFORM) {
  throw new Error(`The pinned Kubo oracle requires ${KUBO_PLATFORM}`);
}

function deterministicBytes(length, seed) {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;

  for (let i = 0; i < bytes.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }

  return bytes;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status}: ${result.stderr.trim()}`
    );
  }

  return result.stdout.trim();
}

const archiveSha512 = createHash('sha512')
  .update(readFileSync(kuboArchive))
  .digest('hex');
if (archiveSha512 !== KUBO_RELEASE_ARCHIVE_SHA512) {
  throw new Error(`Kubo release archive SHA-512 mismatch: ${archiveSha512}`);
}

const vectors = [
  {
    name: 'empty',
    bytes: new Uint8Array(),
    cid: 'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH',
  },
  {
    name: 'one byte',
    bytes: new Uint8Array([0]),
    cid: 'QmS9JArPwa55ePgDnyg6TzX24mYTS1b1vLqWNebyVotKxQ',
  },
  {
    name: 'one byte below the chunk boundary',
    bytes: deterministicBytes(262_143, 0x74300001),
    cid: 'QmUyAoXWC2cDzwe5bkjtW1MnHoiN6M3hwRsEfrq9Mi9jnJ',
  },
  {
    name: 'at the chunk boundary',
    bytes: deterministicBytes(262_144, 0x74300002),
    cid: 'QmQsQgWkAHNvh4Qe9JqS9GCE8W6JEixunCP3XwiQgToBCa',
  },
  {
    name: 'one byte above the chunk boundary',
    bytes: deterministicBytes(262_145, 0x74300003),
    cid: 'QmW8NLqqzrschsPfx5u4H6wPrEQAmFJeuMUGMLrdoK68ew',
  },
  {
    name: 'multiple chunks',
    bytes: deterministicBytes(3 * 262_144 + 17, 0x74300004),
    cid: 'QmVdFRZsFQs7jCTs56Z9dk59vB2dsAHNHwq7hNkiEVdx46',
  },
  {
    name: 'one MiB',
    bytes: deterministicBytes(1024 * 1024, 0x74300005),
    cid: 'QmPtqKXT8BGjrchrReXZ4gpD8dCAZTM82UD2EYG4TbpVuE',
  },
];

const kuboRoot = mkdtempSync(join(tmpdir(), 'cannon-kubo-oracle-'));
const kuboRepo = join(kuboRoot, 'repo');

try {
  run('tar', ['-xzf', kuboArchive, '-C', kuboRoot]);

  const kuboBinary = join(kuboRoot, 'kubo', 'ipfs');
  const installedVersion = run(kuboBinary, ['version', '--number']);
  if (installedVersion !== KUBO_VERSION) {
    throw new Error(
      `Expected Kubo ${KUBO_VERSION}, received ${installedVersion}`
    );
  }

  const kuboEnv = { ...process.env, IPFS_PATH: kuboRepo };
  run(kuboBinary, ['init', '--empty-repo'], { env: kuboEnv });

  for (const vector of vectors) {
    const kuboCid = run(
      kuboBinary,
      [
        'add',
        '--only-hash',
        '--cid-version=0',
        '--raw-leaves=false',
        '--chunker=size-262144',
        '--quieter',
      ],
      { env: kuboEnv, input: vector.bytes }
    );
    const codecCid = await getContentCID(vector.bytes);

    if (kuboCid !== vector.cid || codecCid !== vector.cid) {
      throw new Error(
        `${vector.name}: expected ${vector.cid}, Kubo returned ${kuboCid}, codec returned ${codecCid}`
      );
    }

    process.stdout.write(`verified ${vector.name}: ${vector.cid}\n`);
  }
} finally {
  rmSync(kuboRoot, { recursive: true, force: true });
}

process.stdout.write(
  `Kubo ${KUBO_VERSION} oracle verified (${KUBO_PLATFORM} archive SHA-512 ${KUBO_RELEASE_ARCHIVE_SHA512})\n`
);
