import assert from 'node:assert/strict';
import test from 'node:test';
import LegacyHash from 'typestub-ipfs-only-hash';
import {
  compress,
  extractValidCid,
  getContentCID,
  getContentUrl,
  getIpfsCid,
  getIpfsUrl,
  parseIpfsCid,
  uncompress,
} from '../dist/index.js';

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

const KUBO_VECTORS = [
  {
    name: 'empty',
    size: 0,
    bytes: new Uint8Array(),
    cid: 'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH',
  },
  {
    name: 'one byte',
    size: 1,
    bytes: new Uint8Array([0]),
    cid: 'QmS9JArPwa55ePgDnyg6TzX24mYTS1b1vLqWNebyVotKxQ',
  },
  {
    name: 'hello world',
    size: 11,
    bytes: new TextEncoder().encode('hello world'),
    cid: 'Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD',
  },
  {
    name: 'one byte below the chunk boundary',
    size: 262_143,
    seed: 0x74300001,
    cid: 'QmUyAoXWC2cDzwe5bkjtW1MnHoiN6M3hwRsEfrq9Mi9jnJ',
  },
  {
    name: 'at the chunk boundary',
    size: 262_144,
    seed: 0x74300002,
    cid: 'QmQsQgWkAHNvh4Qe9JqS9GCE8W6JEixunCP3XwiQgToBCa',
  },
  {
    name: 'one byte above the chunk boundary',
    size: 262_145,
    seed: 0x74300003,
    cid: 'QmW8NLqqzrschsPfx5u4H6wPrEQAmFJeuMUGMLrdoK68ew',
  },
  {
    name: 'multiple chunks',
    size: 3 * 262_144 + 17,
    seed: 0x74300004,
    cid: 'QmVdFRZsFQs7jCTs56Z9dk59vB2dsAHNHwq7hNkiEVdx46',
  },
  {
    name: 'one MiB',
    size: 1024 * 1024,
    seed: 0x74300005,
    cid: 'QmPtqKXT8BGjrchrReXZ4gpD8dCAZTM82UD2EYG4TbpVuE',
  },
  {
    name: 'repository maximum',
    size: 50 * 1024 * 1024,
    seed: 0x74300007,
    cid: 'QmTTZQXcktT3YTRj7DzRYTE1iQU4rD8rionM8fUvpXwaMU',
  },
];

const RANDOM_CORPUS = [
  [217_358, 3_201_528_029, 'QmSWazs97Dpyj2pgq4qnWjmscKmsJBrLvBj3JTjz6xY9GJ'],
  [168_608, 1_474_876_960, 'QmUszzkXsRVk4PkxpwcYMpyGxPpTyC2p1RqzVCXsGYb71t'],
  [167_484, 2_245_022_493, 'QmR5cRhtVuAGtDyNdryE66KPiosAuFCahQJHCNj19QnJjV'],
  [222_543, 24_890_717, 'QmbQUNDMckmp7USKDxybrLV9oDeBf1J7tGKV7nR5NM3ujH'],
  [63_082, 3_982_770_843, 'QmQqSX5UhrpzBTZ2WGWop4zPa4fqwfQMjfUqw8YuyiMzPF'],
  [42_257, 2_430_724_345, 'Qmasf4n71PZTYyEasA7JE8WK9yZeaKccGMBx2NyLeuTiaY'],
  [286_650, 2_092_218_958, 'QmcboeTGMebP8bLgV1RzSvV2A7kp5MkLSxnZjmd8mjsSj6'],
  [195_709, 689_900_106, 'QmNgZYko3ms5b8mXidg13W3GjBcKLEbvnomFJu7ZuoirJK'],
  [112_671, 3_398_887_076, 'QmUt7otfJQKnZYjkMkLPCdV4su65yJGsAwgyEgBpjkqEsg'],
  [193_167, 3_652_135_501, 'QmSZHJqvC7M1KFUydADYBBc5RqFvL2uPAK3LiBv7811Gtd'],
  [291_089, 2_306_819_780, 'Qmd6K6roPf6daa7zqsFePqVn57mgsaK9RXKna32VFwd7md'],
  [166_331, 780_268_472, 'QmT6J9yMd6PtzpNWqVBzvrkwGEtK11P6tzoZwhSZfBd2mj'],
  [197_583, 2_282_735_042, 'QmNxHf55dQrpHmzcA5efDAG7mUGK7EtBs4vAnqwxTn2e9c'],
  [11_564, 3_005_116_214, 'QmY6zuo2b4JY6WBK4fasG84wG788RbpXnQPVNVJFb3SHqW'],
  [90_254, 2_286_728_351, 'Qmbm3H7NGviUMdPShU5JpXgggd4iNWA1U16dhC3Jwfo8NL'],
  [113_548, 1_931_023_964, 'QmfRTPrt3NLNSDBrBcb9WXhiypPoD6R3PXcN6dzQWThyfE'],
  [110_180, 3_872_669_615, 'QmaLGpLSPfoWWFDvEWa6R1VqZws4HWMGD12bb9sqzC3R5G'],
  [24_886, 3_557_096_516, 'QmRT1mz3VyShqnZxgTVayhWM5KEDYhUxLktXqPcM6YuZPE'],
  [9_066, 640_121_674, 'QmdXXPk82paszeWaY9PvspsV3Ys2zeV6dh8ytK9wAZXUDq'],
  [202_844, 1_346_896_599, 'Qma3GY68QvoHWjgZKxc9QXz7EJid35hJxVf2aN6MyEkKPe'],
  [65_018, 2_419_958_709, 'QmTfhmeLtYDzALRJDpLt8UrvAXSjDssov7dPpDQs5hYXjG'],
  [153_844, 953_165_028, 'QmaS7hHHeLuSHxJDfQrJsBzRwELmiqqwMn2jxHBWeUtvWF'],
  [53_508, 3_912_969_453, 'QmQEaUHypVN69MGY2iW4YWQt1sZcc4HGrhPYrL3PiJsurD'],
  [4_183, 4_159_379_323, 'QmSLyJHXkyNELUvQK69yJN3j9TfetCNAifC7y33iW7Wuhu'],
];

for (const { name, size, seed, bytes, cid } of KUBO_VECTORS) {
  test(`getContentCID matches the Kubo CIDv0 fixture for ${name}`, async () => {
    const content = bytes ?? deterministicBytes(size, seed);
    assert.equal(await getContentCID(content), cid);
    assert.equal(await LegacyHash.of(content), cid);
  });
}

test('getContentCID matches the legacy implementation over a deterministic random corpus', async () => {
  for (const [size, seed, expectedCid] of RANDOM_CORPUS) {
    const content = deterministicBytes(size, seed);
    const [actualCid, legacyCid] = await Promise.all([
      getContentCID(content),
      LegacyHash.of(content),
    ]);

    assert.equal(actualCid, expectedCid);
    assert.equal(actualCid, legacyCid);
  }
});

test('getContentCID is deterministic for equal bytes', async () => {
  const first = deterministicBytes(524_321, 0x7430d00d);
  assert.equal(await getContentCID(first), await getContentCID(first.slice()));
});

for (const [name, value, expectedCid] of [
  [
    'multibyte Unicode',
    'Cannon CID 🚀 — こんにちは',
    'QmZ2e7ad1h24r4jpKtV9BCDFEuig9BgpMqkfuGywboXdcs',
  ],
  [
    'a lone surrogate',
    '\ud800',
    'QmTFs8cxGDXJL7FqWKfAbveU3KQQMPgf3TFwuVdQmVPTv8',
  ],
]) {
  test(`getContentCID preserves legacy string encoding for ${name}`, async () => {
    assert.equal(await getContentCID(value), expectedCid);
    assert.equal(await LegacyHash.of(value), expectedCid);
  });
}

test('artifact encoding round trips compressed JSON bytes', () => {
  const source = JSON.stringify({
    cannon: true,
    nested: { value: 'artifact' },
  });
  assert.equal(uncompress(compress(source)), source);
});

test('artifact encoding returns the legacy content URL shape', async () => {
  assert.match(
    await getContentUrl({ hello: 'world' }),
    /^ipfs:\/\/Qm[1-9A-HJ-NP-Za-km-z]{44}$/
  );
  assert.equal(await getContentUrl(undefined), null);
});

test('CID parsing preserves strict and URL-prefixed parsing', () => {
  const cid = 'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH';
  assert.equal(parseIpfsCid(cid), cid);
  assert.equal(parseIpfsCid(`ipfs://${cid}`), null);
  assert.equal(getIpfsCid(cid), cid);
  assert.equal(getIpfsCid(`ipfs://${cid}`), cid);
  assert.equal(getIpfsUrl(cid), `ipfs://${cid}`);
  assert.equal(extractValidCid(cid), cid);
});

test('CID parsing rejects malformed inputs without changing error compatibility', () => {
  assert.equal(parseIpfsCid(null), null);
  assert.equal(getIpfsCid('not-a-cid'), null);
  assert.equal(getIpfsUrl('not-a-cid'), null);
  assert.throws(
    () => extractValidCid('not-a-cid'),
    new Error('Invalid CID not-a-cid')
  );
});
