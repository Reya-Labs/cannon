import * as artifactCodec from '@usecannon/artifact-codec';
import artifactCodecPackage from '../../artifact-codec/package.json';
import rootPackage from '../../../package.json';
import builderPackage from '../package.json';
import {
  compress,
  extractValidCid,
  getContentCID,
  getContentUrl,
  getIpfsCid,
  getIpfsUrl,
  parseIpfsCid,
  uncompress,
} from './ipfs';
import { getContentCID as getContentCIDFromBuilder } from './index';

describe('artifact codec compatibility exports', () => {
  it('declares the conservative Node 20 support floor', () => {
    expect(artifactCodecPackage.engines.node).toBe('>=20.0.0');
    expect(builderPackage.engines.node).toBe('>=20.0.0');
    expect(rootPackage.engines.node).toBe('>=20.0.0');
  });

  it('keeps every legacy builder IPFS codec export wired to the shared package', () => {
    expect(compress).toBe(artifactCodec.compress);
    expect(uncompress).toBe(artifactCodec.uncompress);
    expect(getContentCID).toBe(artifactCodec.getContentCID);
    expect(getContentUrl).toBe(artifactCodec.getContentUrl);
    expect(parseIpfsCid).toBe(artifactCodec.parseIpfsCid);
    expect(getIpfsCid).toBe(artifactCodec.getIpfsCid);
    expect(getIpfsUrl).toBe(artifactCodec.getIpfsUrl);
    expect(extractValidCid).toBe(artifactCodec.extractValidCid);
    expect(getContentCIDFromBuilder).toBe(artifactCodec.getContentCID);
  });

  it('preserves the legacy Buffer call shape and CIDv0 result', async () => {
    await expect(getContentCID(Buffer.from('hello world'))).resolves.toBe('Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD');
  });
});
