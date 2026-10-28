import { expect, test } from 'bun:test';

// Dependabot bumps the Dockerfile and mise.toml separately; the image must run the Bun that CI and development use.
test('the Dockerfile builds with the Bun version pinned in mise.toml', async () => {
  const mise = (await Bun.file(new URL('../mise.toml', import.meta.url)).text()).match(/^bun = "([^"]+)"$/m)?.[1];
  const docker = (await Bun.file(new URL('../Dockerfile', import.meta.url)).text()).match(
    /^ARG BUN_VERSION=(.+)$/m
  )?.[1];
  expect(mise).toBeString();
  expect(docker).toBe(mise);
});
