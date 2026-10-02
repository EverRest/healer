import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAgentAuthored, resolveFromEnv } from './agent-identity.mjs';

// The host's own account-type answer, keyed by login; a login not in the map is unresolvable.
const accounts: Record<string, string> = {
  'healer-agent[bot]': 'Bot',
  alice: 'User',
  bob: 'User',
};
const fetchUser = async (login: string) => {
  if (!(login in accounts)) throw new Error(`404 ${login}`);
  return { type: accounts[login] };
};
const inCI = { inCI: true, fetchUser };

describe('author identity (012 T084, FR-054, R-13, quickstart 38)', () => {
  it('is human only when both the PR author and the triggering actor resolve to non-bot accounts', async () => {
    expect(await isAgentAuthored({ ...inCI, prAuthor: 'alice', actor: 'bob' })).toBe(false);
  });

  it('is an agent when the PR author is a bot', async () => {
    expect(await isAgentAuthored({ ...inCI, prAuthor: 'healer-agent[bot]', actor: 'alice' })).toBe(
      true,
    );
  });

  it('is an agent when only the triggering actor is a bot', async () => {
    expect(await isAgentAuthored({ ...inCI, prAuthor: 'alice', actor: 'healer-agent[bot]' })).toBe(
      true,
    );
  });

  it('is an agent when either identity cannot be resolved (quickstart 38)', async () => {
    expect(await isAgentAuthored({ ...inCI, prAuthor: 'ghost', actor: 'alice' })).toBe(true);
    expect(await isAgentAuthored({ ...inCI, prAuthor: 'alice', actor: 'ghost' })).toBe(true);
  });

  it('is an agent when an identity is absent altogether', async () => {
    expect(await isAgentAuthored({ ...inCI, actor: 'alice' })).toBe(true);
    expect(await isAgentAuthored({ ...inCI, prAuthor: 'alice' })).toBe(true);
  });

  it('is an agent when the host answers without an account type', async () => {
    const odd = async () => ({}) as { type: string };
    expect(
      await isAgentAuthored({ inCI: true, fetchUser: odd, prAuthor: 'alice', actor: 'bob' }),
    ).toBe(true);
  });

  it('outside CI is an agent unless the developer declares otherwise', async () => {
    expect(await isAgentAuthored({ inCI: false, fetchUser })).toBe(true);
    expect(await isAgentAuthored({ inCI: false, fetchUser, declared: 'human' })).toBe(false);
    expect(await isAgentAuthored({ inCI: false, fetchUser, declared: 'agent' })).toBe(true);
  });

  it('in CI a declaration changes nothing — only the resolved identity is authoritative', async () => {
    const bot = { ...inCI, prAuthor: 'healer-agent[bot]', actor: 'alice' };
    expect(await isAgentAuthored({ ...bot, declared: 'human' })).toBe(true);
  });
});

describe('resolveFromEnv', () => {
  const eventFile = (login: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'identity-')), 'event.json');
    writeFileSync(path, JSON.stringify({ pull_request: { user: { login } } }));
    return path;
  };

  it('reads the PR author from the event payload and the actor from GITHUB_ACTOR', async () => {
    const env = { CI: 'true', GITHUB_ACTOR: 'alice', GITHUB_EVENT_PATH: eventFile('bob') };
    expect(await resolveFromEnv(env, fetchUser)).toBe(false);
    expect(await resolveFromEnv({ ...env, GITHUB_ACTOR: 'healer-agent[bot]' }, fetchUser)).toBe(
      true,
    );
  });

  it('treats a CI run with no pull-request payload as unresolvable', async () => {
    expect(await resolveFromEnv({ CI: 'true', GITHUB_ACTOR: 'alice' }, fetchUser)).toBe(true);
  });

  it('reads the developer declaration from HEALER_AUTHOR_IDENTITY outside CI', async () => {
    expect(await resolveFromEnv({ HEALER_AUTHOR_IDENTITY: 'human' }, fetchUser)).toBe(false);
    expect(await resolveFromEnv({}, fetchUser)).toBe(true);
  });
});
