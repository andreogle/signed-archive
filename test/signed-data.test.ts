import { describe, expect, test } from 'bun:test';
import { hasValidSignature, type SignedDatum, toSignedDatum } from '../src/signed-data.ts';

// Real records from signed-api.api3.org (Nodary airnode), fetched 2026-10-27.
const base: SignedDatum = {
  airnode: '0xc52EeA00154B4fF1EbbF8Ba39FDe37F1AC3B9Fd4',
  encodedValue: '0x0000000000000000000000000000000000000000000000000fdb370032a5a970',
  signature:
    '0x1085dbcc574bdf581ea550dceb7fa7c721f41403cfd5f3995558590b6d7a269466ce608b349c5bc93f4a2565e4db50369851f9c1f1e296ca5c27f2e848d433e21c',
  templateId: '0x1005ab8474c226d7255f8d1dd8a3a4ee6234d55d35f2635f40facc3d739a866a',
  timestamp: '1793132927',
};
const oev: SignedDatum = {
  airnode: '0xc52EeA00154B4fF1EbbF8Ba39FDe37F1AC3B9Fd4',
  encodedValue: '0x0000000000000000000000000000000000000000000000000fdb370032a5a970',
  signature:
    '0x0be7097b14ac22ecd29098322d10609d7d589efd2f78191bcd5bc552c7816bf42598dbf1d29d3fff54b974629b5b0e64f4e7288be22514db5ebc3dc9620a74961c',
  templateId: '0x994c0f28c39958a9712ae3972e0418b72579d8c2d7c0fa8cd658e929e8860ad3',
  timestamp: '1793132937',
};

describe('hasValidSignature', () => {
  test('accepts real base and OEV records', async () => {
    expect(await hasValidSignature(base)).toBe(true);
    expect(await hasValidSignature(oev)).toBe(true);
  });

  test('rejects edited value, timestamp, template or signer', async () => {
    expect(await hasValidSignature({ ...base, encodedValue: `0x${base.encodedValue.slice(2, -1)}1` })).toBe(false);
    expect(await hasValidSignature({ ...base, timestamp: '1793132928' })).toBe(false);
    expect(await hasValidSignature({ ...base, templateId: oev.templateId })).toBe(false);
    expect(await hasValidSignature({ ...base, airnode: '0x0000000000000000000000000000000000000001' })).toBe(false);
  });

  test('rejects a well-formed but unrecoverable signature instead of throwing', async () => {
    expect(await hasValidSignature({ ...base, signature: `0x${'00'.repeat(65)}` })).toBe(false);
  });
});

describe('toSignedDatum', () => {
  test('keeps a well-formed record and drops malformed ones', () => {
    expect(toSignedDatum(base)).toEqual(base);
    expect(toSignedDatum({ ...base, timestamp: 1793132927 })).toBeNull();
    expect(toSignedDatum({ ...base, signature: '0x1234' })).toBeNull();
    expect(toSignedDatum(null)).toBeNull();
  });

  test('drops timestamps a number cannot hold exactly, so a stored record always matches its signature', () => {
    expect(toSignedDatum({ ...base, timestamp: '9007199254740991' })).toEqual({
      ...base,
      timestamp: '9007199254740991',
    });
    expect(toSignedDatum({ ...base, timestamp: '9007199254740993' })).toBeNull();
    expect(toSignedDatum({ ...base, timestamp: '18446744073709551615' })).toBeNull();
  });
});
