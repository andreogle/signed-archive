// Regenerates src/airnodes.json and src/feeds.json from @api3/api-integrations, API3's own list of
// data providers and the feeds each one serves. Run `bun run airnodes` after bumping that package.
// With `--check` it changes nothing and fails if a committed file is out of date, so a Dependabot
// bump that adds a provider or feed shows up in CI.
import { apisData, deriveTemplateId, getAllDataFeeds, getSupportedProvidersForDataFeed } from '@api3/api-integrations';

// Mock providers have no Signed API URL and never serve real data.
const apis = Object.values(apisData).filter((api) => api.signedApiUrl !== '');
const airnodes = apis.map(({ alias, airnode }) => ({ alias, airnode })).sort((a, b) => a.alias.localeCompare(b.alias));

// Feed name -> provider alias -> base template ID. OEV template IDs are derived from these at runtime.
const byAlias = new Map(apis.map((api) => [api.alias, api.airnode]));
const feeds: Record<string, Record<string, string>> = {};
for (const feedName of getAllDataFeeds().sort()) {
  const providers: Record<string, string> = {};
  for (const alias of getSupportedProvidersForDataFeed(feedName).sort()) {
    const airnodeAddress = byAlias.get(alias);
    if (airnodeAddress) providers[alias] = deriveTemplateId({ feedName, airnodeAddress });
  }
  feeds[feedName] = providers;
}

const files = [
  { path: new URL('../src/airnodes.json', import.meta.url), json: `${JSON.stringify(airnodes, null, 2)}\n` },
  { path: new URL('../src/feeds.json', import.meta.url), json: `${JSON.stringify(feeds, null, 2)}\n` },
];

for (const { path, json } of files) {
  if (!process.argv.includes('--check')) {
    await Bun.write(path, json);
  } else if ((await Bun.file(path).text()) !== json) {
    console.error(`${path.pathname} is out of date. Run \`bun run airnodes\` and commit the result.`);
    process.exit(1);
  }
}
