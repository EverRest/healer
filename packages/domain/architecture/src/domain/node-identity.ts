import { randomBytes } from 'node:crypto';

/**
 * Mints a UUID v7 (RFC 9562) identity for a graph node: a 48-bit millisecond timestamp prefix
 * (ids sort roughly by creation order) followed by 74 random bits. **Never derived from a path,
 * a repository location or any other value that can change** (R-12) — a directory move or a
 * Kubernetes resource rename must never look like a delete-and-recreate. `natural_key` is the
 * only thing that ever changes for a renamed element; the id minted here does not.
 *
 * Implemented directly on `node:crypto.randomBytes` rather than a UUID dependency — sixteen
 * bytes of RFC-specified bit layout does not earn a package.
 */
export function mintNodeId(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Math.floor(now));
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
