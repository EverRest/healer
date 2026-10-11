# ADR 0019: Verifying a host-issued OIDC identity token on the executor callback

## Status

Proposed — 2026-10-11. Required by 014 FR-017 before any JWT/OIDC dependency is added (AGENTS.md:
new dependency → ADR first). The dependency is **not** added by this ADR; it is added, with this ADR
moved to Accepted, in the change that builds the callback route (`deps-check` requires a changed ADR
naming the package in that same change set).

## Context

014's executor reports back through `POST /api/v1/intake/jobs/{jobId}/events`. The caller is a
GitHub Actions run; its credential is the run's OIDC identity token — a JWT signed with RS256 by
`https://token.actions.githubusercontent.com`, keys published as a JWKS that rotates, claims naming
the repository, run, attempt and workflow (014 research R-04). Verifying it means: fetch and cache
the key set by `kid`, refuse any algorithm but RS256 (no `none`, no HMAC with the public key as
secret), check `iss`, `aud`, `exp` and `nbf` with a small clock tolerance, and only then read the
claims. The same library can sign the GitHub App's RS256 JWT that mints installation tokens for the
dispatcher (R-06), which today has no implementation either.

Nothing in the repository verifies a JWT. `node:crypto` can verify an RS256 signature over a JWK.

## Candidates

| | `jose` | `jsonwebtoken` + `jwks-rsa` | `fast-jwt` + `get-jwks` |
|---|---|---|---|
| Packages added | 1, no runtime dependencies | 2, plus their transitive set (`jwks-rsa` brings `lru-memoizer`, `debug`, its own copy of `jose`, Express types) | 2, plus their transitive set |
| Remote key set | built in: `createRemoteJWKSet` with caching, cooldown and `kid` lookup | `jwks-rsa` with its own cache | `get-jwks` with its own cache |
| Algorithm pinning | required argument (`algorithms: ['RS256']`) | option; the library's history includes algorithm-confusion advisories fixed in v9 | option |
| Module format | ESM and CJS, Node and web crypto | CJS | CJS |
| Also signs the App JWT | yes | yes (`jsonwebtoken`) | yes |
| Tests without network | `createLocalJWKSet` with a test key | stub the client | stub the fetcher |
| Licence | MIT | MIT | Apache-2.0 / MIT |

**Not a library — `node:crypto` by hand**: no dependency, roughly a hundred lines. Rejected as the
default: the lines are the security-sensitive ones (header parsing, algorithm allowlist, key-set
caching across rotation, claim and clock checks), and they would be ours to get right and keep right.
It stays the fallback if the dependency is refused.

## Decision (proposed)

Use **`jose`**, pinned to an exact version, in `packages/integrations/src/github/` only — behind the
intake's `CallbackVerifier` port, so no domain package imports it (014 contracts/executor-port.md).
Verification fixes in code, not configuration: issuer literal, `algorithms: ['RS256']`, audience
from intake configuration, required claims `repository_id`, `run_id`, `run_attempt`,
`job_workflow_ref`, `event_name`, clock tolerance 60 s. Tests use `createLocalJWKSet`; the issuer
literal is not overridable, so a test hands the verifier a local key set by constructor argument.

## Consequences

- \+ One small dependency covers both the callback and the dispatcher's App JWT.
- \+ The key-rotation and algorithm-pinning code is the library's, exercised by its other users.
- − A new runtime dependency on the control plane's request path; it enters `deps-check`'s allowlist
  and the constitution's dependency note in the implementing change.
- − Fetching GitHub's key set is an outbound call from the API process; a failure refuses callbacks
  (fail closed) until the cache refills, and the deadline sweep times the job out if it lasts.
