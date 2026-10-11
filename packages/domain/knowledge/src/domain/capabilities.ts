/**
 * The capability an authenticated human must hold to adopt an expectation in-product (005 T016,
 * FR-011, R-02, R-16, retrieval-contract.md §2). In v1 the only adoption path is the repository
 * merge-request approval, so **no endpoint serves this capability** and no agent or automation
 * credential carries it; it is declared now so the deferred in-product path needs no new
 * capability later.
 *
 * What reads this constant today: `knowledge-adopt-capability.test.ts`, a structural scan that
 * fails if the string or this constant appears in any other source file (credential/capability
 * lists, agents, runner, MCP, worker) or if an adopt route/tool is declared. That scan is a drift
 * detector, not the security boundary. No credential registry exists yet — 002-policy owns it —
 * so what will read it later is that registry: it types a credential's capability list with
 * `KnowledgeAdoptCapability` (a typo becomes a type error), grants it only to human-role
 * credentials, and the future adopt endpoint's guard will require it. When either lands, its file
 * joins the test's allowlist, deliberately and in review.
 */
export const KNOWLEDGE_ADOPT_CAPABILITY = 'knowledge:adopt' as const;
export type KnowledgeAdoptCapability = typeof KNOWLEDGE_ADOPT_CAPABILITY;
