// Regenerates src/airnodes.json from @api3/api-integrations, API3's own list of data providers.
// Run `bun run airnodes` after bumping that package. With `--check` it changes nothing and fails
// if the committed file is out of date, so a Dependabot bump that adds a provider shows up in CI.
import { apisData } from '@api3/api-integrations';

const path = new URL('../src/airnodes.json', import.meta.url);

// Mock providers have no Signed API URL and never serve real data.
const airnodes = Object.values(apisData)
  .filter((api) => api.signedApiUrl !== '')
  .map(({ alias, airnode }) => ({ alias, airnode }))
  .sort((a, b) => a.alias.localeCompare(b.alias));
const json = `${JSON.stringify(airnodes, null, 2)}\n`;

if (!process.argv.includes('--check')) {
  await Bun.write(path, json);
} else if ((await Bun.file(path).text()) !== json) {
  console.error('src/airnodes.json is out of date. Run `bun run airnodes` and commit the result.');
  process.exit(1);
}
