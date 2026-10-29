import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog } from '../src/catalog.ts';
import { catalogInput, parseSettings } from '../src/settings.ts';
import type { SignedDatum } from '../src/signed-data.ts';
import { openStore } from '../src/store.ts';

// The catalog from the committed config file, so tests check against the real airnode and feed lists.
export const catalog = createCatalog(
  catalogInput(parseSettings(await Bun.file(new URL('../signed-archive.yaml', import.meta.url)).text()))
);

// Real ETH/USD records from signed-api.api3.org, archived 2026-10-28.
export const blocksize: SignedDatum[] = [
  {
    airnode: '0xBA910Eb2867977A0a651FE3D2607237ff4116B1C',
    templateId: '0xc853e5b91b5326ffb4779de80a64e5bec73ab01747093036d565d7fce84bd733',
    timestamp: '1793206903',
    encodedValue: '0x00000000000000000000000000000000000000000000007e701bc398b2648e80',
    signature:
      '0x50475dfc4a14e77fe7e6fc0918e142f28303e8a65e8895da08e969dc0f04cc160540daa345d5dd6e0f36edbdc78bd05f73384c100574f006a85a3ac87cbe28551b',
  },
  {
    airnode: '0xBA910Eb2867977A0a651FE3D2607237ff4116B1C',
    templateId: '0xc853e5b91b5326ffb4779de80a64e5bec73ab01747093036d565d7fce84bd733',
    timestamp: '1793206951',
    encodedValue: '0x00000000000000000000000000000000000000000000007e6df273787c050180',
    signature:
      '0x57c434db51464db34bf97ed8cd95027eb168cf4484b5a32645ede6ac9c0a8c5e198d29c57b386bb069f32e1e983a0f8110af7a173be77da9920d7c674e1f10251b',
  },
];
export const coingecko: SignedDatum = {
  airnode: '0x9dB03a07bE313B3C08261B1d1606D511f3560D9e',
  templateId: '0xdeda2f7938bf877d2f011aa550852d3459794e16944ea0b7513465479752ba93',
  timestamp: '1793206907',
  encodedValue: '0x00000000000000000000000000000000000000000000007e7a67cfa7479f0000',
  signature:
    '0x0ef721c1b0d122fa68425236bfb8106b9266b09a6ed160f1faa55e6180b19ef624366e9840a8935f27ec07bff4aa82622ae624bcd213b51ae34a49c50ab17fcc1c',
};
export const coinmetrics: SignedDatum = {
  airnode: '0x2D652E95524c4b6D09FA149F66e2168222cd27a5',
  templateId: '0xd4a4bf4e3d7c0f5e41a5eb2453d7c14624b9566c369a2e60afedafa841098138',
  timestamp: '1793206912',
  encodedValue: '0x00000000000000000000000000000000000000000000007e5cb500fddc490000',
  signature:
    '0x9e0a3853757897321d9ba42c58780cfd9ec9ee1ab068b4c9ade48301c39910861cbda606a7fcd6356d2567d9f4f82552e76d03f1096afe7337314f1a0a2d007b1b',
};
// Signed under the OEV template ID, keccak256 of coingecko's base template ID.
export const coingeckoOev: SignedDatum = {
  airnode: '0x9dB03a07bE313B3C08261B1d1606D511f3560D9e',
  templateId: '0xc3f990e630fef8e6bf17b419ae4b0820ee5e026ccb26d22533be09cf275d23e1',
  timestamp: '1793206922',
  encodedValue: '0x00000000000000000000000000000000000000000000007e6e0de55e6d860000',
  signature:
    '0x392cb9cd6ad6341cad89abc1176f0e8ba167a95913d46d26c3b928c1d1b14ec66a071f53612539e2bdc6532152e8c9c4b84d021e090f10f87c5664187da1a2f31b',
};

// Writes the fixtures through the archiver's own store, so tests read exactly what it writes.
export function fixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), 'signed-archive-'));
  const path = join(dir, 'archive.sqlite');
  const store = openStore(path);
  for (const datum of [...blocksize, coingecko, coinmetrics]) {
    store.save([datum], {
      airnode: datum.airnode,
      endpoint: 'public',
      source: 'api3',
      fetchedAt: 1_793_207_000_000,
      status: 200,
      received: 1,
      rejected: 0,
    });
  }
  store.save([coingeckoOev], {
    airnode: coingeckoOev.airnode,
    endpoint: 'public-oev',
    source: 'api3',
    fetchedAt: 1_793_207_000_000,
    status: 200,
    received: 1,
    rejected: 0,
  });
  store.close();
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
