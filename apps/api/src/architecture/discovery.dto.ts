import { z } from 'zod';

/** `POST /discovery/runs` body (`contracts/openapi.yaml`): `trigger` is 003 FR-014's own closed
 *  set, `sources` names adapter keys — omitted means every connected source (FR-022).
 *
 *  The confirm/reject request schemas are declared in `discovery-drafts.controller.ts` itself,
 *  not here — `scripts/gates/graph-confirm-capability.mjs` expects every confirm-shaped surface
 *  under `apps/api/src` to reference `GRAPH_CONFIRM_CAPABILITY`, and a schema named
 *  `confirmDraftItemsRequestSchema` living in a file with no other reason to import that constant
 *  would be exactly the kind of incidental match that gate exists to flag — co-locating it with
 *  the controller that already references the capability for a real reason is the smaller diff
 *  than adding a second, dummy reference here. */
export const startDiscoveryRunRequestSchema = z
  .object({
    trigger: z.enum(['onboarding', 'scheduled', 'manual', 'post_deploy']),
    sources: z.array(z.string().min(1)).optional(),
    // Optional, caller-supplied — not in contracts/openapi.yaml's hand-written request body
    // today (same undocumented-field shape 012 T042's own `name` field already is, QUESTIONS.md
    // "012 phase 6"). No real dispatch-to-runner mechanism exists yet to populate this from a
    // registered runner (discovery-runs.controller.ts's own scope note); accepting it now costs
    // nothing and gives a real caller a seam for the day one does, rather than inventing one.
    runnerId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
