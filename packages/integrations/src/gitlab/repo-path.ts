/**
 * Pure path guard for repository-relative paths read through a host API. Rejects (returns false)
 * NUL, backslash, absolute paths, and empty / `.` / `..` segments — so neither traversal nor a
 * Windows-style separator can step outside the configured prefix.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.includes('\0') || path.includes('\\') || path.startsWith('/')) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** `prefix` is '' (whole repository) or a safe relative directory; trailing slash tolerated. */
export function isUnderPrefix(prefix: string, path: string): boolean {
  const dir = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (dir !== '' && !isSafeRepoPath(dir)) return false;
  return isSafeRepoPath(path) && (dir === '' || path.startsWith(`${dir}/`));
}
