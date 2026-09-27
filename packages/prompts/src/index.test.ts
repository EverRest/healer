import { describe, expect, it } from 'vitest';
import { computePromptDigest, publish, resolveByVersionId } from './index.js';

const INPUT = {
  key: 'diagnosis.hypothesis',
  body: 'You are an investigator...',
  publishedBy: 'alice',
};

describe('publish (012 T063, T064, R-07, quickstart 15)', () => {
  it('publishes a new version when the key has none yet', () => {
    const result = publish(INPUT, []);
    expect(result.outcome).toBe('published');
    expect(result.version.digest).toBe(computePromptDigest(INPUT.body));
  });

  it('republishing identical content is a no-op, returning the existing version unchanged', () => {
    const first = publish(INPUT, []);
    const second = publish(INPUT, [first.version]);
    expect(second.outcome).toBe('no-op');
    expect(second.version.id).toBe(first.version.id);
  });

  it('publishing changed content creates a new version — never mutates the existing one', () => {
    const first = publish(INPUT, []);
    const second = publish({ ...INPUT, body: 'You are an investigator, revised.' }, [
      first.version,
    ]);
    expect(second.outcome).toBe('published');
    expect(second.version.id).not.toBe(first.version.id);
    expect(second.version.digest).not.toBe(first.version.digest);
    // The first version is untouched — proof there is no update path, not just no update call.
    expect(first.version.body).toBe(INPUT.body);
  });

  it('exports no update/republish-in-place function — the surface itself has no update path', async () => {
    const module = await import('./index.js');
    expect(Object.keys(module).some((name) => /update/i.test(name))).toBe(false);
  });
});

describe('resolveByVersionId — the only resolver (FR-039)', () => {
  it('resolves an existing version by id', () => {
    const { version } = publish(INPUT, []);
    expect(resolveByVersionId(version.id, [version])).toEqual(version);
  });

  it('returns undefined for an unknown id, never falling back to a name-based lookup', () => {
    expect(resolveByVersionId('unknown-id', [publish(INPUT, []).version])).toBeUndefined();
  });

  it('exports no resolveByKey — resolving by name would let an old entry point at new text', async () => {
    const module = await import('./index.js');
    expect('resolveByKey' in module).toBe(false);
  });
});
