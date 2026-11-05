import { type Address, type Hex, isAddressEqual, keccak256 } from 'viem';
import type { Endpoint } from './config.ts';

// What to archive and how to name it, from local files or a persisted snapshot: providers and base template IDs
// per provider. Pure (viem only, no Bun or Node imports), so the web app builds the same catalog in the browser from
// /api/catalog and runs the same checks with it.

export interface AirnodeEntry {
  alias: string;
  airnode: Address;
  // The provider's own Signed API, archived beside API3's.
  signedApiUrl: string;
}

export interface CatalogInput {
  revision?: number;
  airnodes: AirnodeEntry[];
  // Feed name -> provider alias -> base template ID.
  feeds: Record<string, Record<string, Hex>>;
  // Older signer/template mappings remain evidence even after a provider or feed is retired.
  historical?: (FeedSource & { feed: string })[];
}

export interface FeedSource {
  provider: string;
  airnode: Address;
  templateId: Hex;
  // When this archive observed removal (unix seconds), not when the provider stopped signing.
  retiredAt?: number;
}

// Chart colour slot per provider. A slot belongs to the provider, never to its rank in a list, so a provider keeps its
// colour across feeds and ranges; providers that share a feed always get different slots. Assigned greedily in
// alphabetical order, so the result only changes when the feed list does.
function assignSlots(feeds: ReadonlyMap<string, Record<Endpoint, FeedSource[]>>) {
  const together = new Map<string, Set<string>>();
  for (const { public: sources } of feeds.values()) {
    for (const { provider } of sources) {
      const others = together.get(provider) ?? new Set<string>();
      for (const other of sources) if (other.provider !== provider) others.add(other.provider);
      together.set(provider, others);
    }
  }
  const slots = new Map<string, number>();
  for (const provider of [...together.keys()].sort()) {
    const taken = new Set([...(together.get(provider) ?? [])].map((other) => slots.get(other)));
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    slots.set(provider, slot);
  }
  return slots;
}

export function createCatalog(input: CatalogInput) {
  const airnodeByAlias = new Map(input.airnodes.map(({ alias, airnode }) => [alias, airnode]));
  // The Signed API serves OEV data under keccak256(base template ID), so each feed has one source list per endpoint.
  const feeds = new Map<string, Record<Endpoint, FeedSource[]>>(
    Object.entries(input.feeds).map(([name, providers]) => {
      const base = Object.entries(providers).flatMap(([provider, templateId]) => {
        const airnode = airnodeByAlias.get(provider);
        return airnode ? [{ provider, airnode, templateId }] : [];
      });
      const oev = base.map((source) => ({ ...source, templateId: keccak256(source.templateId) }));
      return [name, { public: base, 'public-oev': oev }];
    })
  );
  const activeFeeds: ReadonlyMap<string, Record<Endpoint, FeedSource[]>> = new Map(
    [...feeds].map(([name, sources]) => {
      return [name, { public: [...sources.public], 'public-oev': [...sources['public-oev']] }];
    })
  );
  for (const { feed, ...source } of input.historical ?? []) {
    const held = feeds.get(feed) ?? { public: [], 'public-oev': [] };
    if (
      !held.public.some((entry) => {
        return (
          isAddressEqual(entry.airnode, source.airnode) &&
          entry.templateId.toLowerCase() === source.templateId.toLowerCase()
        );
      })
    ) {
      held.public.push(source);
      held['public-oev'].push({ ...source, templateId: keccak256(source.templateId) });
    }
    feeds.set(feed, held);
  }
  const slots: ReadonlyMap<string, number> = assignSlots(feeds);

  const entryOf = (airnode: string) =>
    input.airnodes.find((entry) => isAddressEqual(entry.airnode, airnode as Address));
  const previousOf = (airnode: string) =>
    input.historical?.find((entry) => isAddressEqual(entry.airnode, airnode as Address));

  // Whether a record belongs to this feed: signed by the provider's listed airnode, under the feed's template ID for
  // this endpoint. A valid signature alone only proves who signed; this ties the signer and template to the feed name.
  function isFeedRecord(
    feed: string,
    endpoint: Endpoint,
    record: { provider: string; airnode: string; templateId: string }
  ) {
    const sources = feeds.get(feed)?.[endpoint] ?? [];
    return sources.some((source) => {
      return (
        source.provider === record.provider &&
        isAddressEqual(source.airnode, record.airnode as Address) &&
        source.templateId.toLowerCase() === record.templateId.toLowerCase()
      );
    });
  }

  // Every known feed source signed by one airnode on one endpoint, one per template ID. Peer repair asks by airnode,
  // and querying by template keeps each lookup on the archive's primary key instead of scanning the whole airnode.
  function sourcesOfAirnode(airnode: string, endpoint: Endpoint): FeedSource[] {
    const byTemplate = new Map<string, FeedSource>();
    for (const sources of feeds.values()) {
      for (const source of sources[endpoint]) {
        if (isAddressEqual(source.airnode, airnode as Address)) byTemplate.set(source.templateId.toLowerCase(), source);
      }
    }
    return [...byTemplate.values()];
  }

  return {
    input,
    airnodes: input.airnodes,
    feeds,
    activeFeeds,
    slots,
    isFeedRecord,
    sourcesOfAirnode,
    // Whether the airnode is one of the configured providers.
    knows: (airnode: string) => entryOf(airnode) !== undefined || previousOf(airnode) !== undefined,
    aliasOf: (airnode: string) => entryOf(airnode)?.alias ?? previousOf(airnode)?.provider,
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
