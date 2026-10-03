// Who authored this change set (012 T084, FR-054, R-13): the host's own bot flag on the pull
// request author and on the workflow's triggering actor — never commit or PR text, which the
// author controls. Anything undeterminable is an agent (R-10).
import { readFileSync } from 'node:fs';

/**
 * @param {{
 *   prAuthor?: string, actor?: string, inCI: boolean, declared?: string,
 *   fetchUser: (login: string) => Promise<{ type?: string }>,
 * }} input
 * @returns {Promise<boolean>} true when agent-authored
 */
export async function isAgentAuthored({ prAuthor, actor, inCI, declared, fetchUser }) {
  // No host to ask locally; only CI's verdict is authoritative (R-13).
  if (!inCI) return declared !== 'human';
  for (const login of [prAuthor, actor]) {
    if (!login) return true;
    try {
      const { type } = await fetchUser(login);
      if (type !== 'User') return true; // Bot, Organization, or an answer we do not understand
    } catch {
      return true;
    }
  }
  return false;
}

/* v8 ignore start -- real GitHub API call; the verdict logic above is unit tested */
async function githubUser(login) {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token && { authorization: `Bearer ${token}` }),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} resolving ${login}`);
  return response.json();
}
/* v8 ignore stop */

export async function resolveFromEnv(env = process.env, fetchUser = githubUser) {
  let prAuthor;
  try {
    prAuthor = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.user?.login;
  } catch {
    // no payload → prAuthor stays undefined → unresolvable → agent
  }
  return isAgentAuthored({
    prAuthor,
    actor: env.GITHUB_ACTOR,
    inCI: env.CI === 'true',
    declared: env.HEALER_AUTHOR_IDENTITY,
    fetchUser,
  });
}
