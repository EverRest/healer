import type { ActionClass } from './action-class.js';

// T011: `ACTION_CEILING` — a pure function of the action class *and* of whether the undo is
// attested (R-05, C-18). "No level" is a real absence in the return type, not `0`: `0` is a
// level (no autonomous execution granted); "none" means nothing can ever be granted for this
// class, full stop.
//
// Named as individually visible constants, not one opaque table literal — R-15's future
// `gate-ceiling` check reads this file's *diff*, and a diff against a named constant is legible
// in a way a diff against a table entry is not.
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type Ceiling = { readonly kind: 'level'; readonly level: AutonomyLevel } | { readonly kind: 'none' };

const READ_ONLY_CEILING: AutonomyLevel = 1;
const CODE_CHANGE_CEILING: AutonomyLevel = 2;
// Distinct from CODE_CHANGE_CEILING even though both are currently L2: writing a branch and
// opening a pull request *is* what L2 means for this class (D-12), which is a different fact
// from the ceiling for producing a patch, and the two are allowed to diverge independently.
const REPOSITORY_WRITE_CEILING: AutonomyLevel = 2;
const REVERSIBLE_REMEDIATION_CEILING: AutonomyLevel = 5;

const NO_LEVEL: Ceiling = { kind: 'none' };

export function ACTION_CEILING(actionClass: ActionClass, hasTestedUndo: boolean): Ceiling {
  switch (actionClass) {
    case 'read_only':
      return { kind: 'level', level: READ_ONLY_CEILING };
    case 'code_change':
      return { kind: 'level', level: CODE_CHANGE_CEILING };
    case 'repository_write':
      return { kind: 'level', level: REPOSITORY_WRITE_CEILING };
    case 'reversible_remediation':
      // The one class with a live L5 — the one place being wrong executes an unattended
      // production action, so the attestation is a parameter of the clamp itself, not left to
      // tenant rule authorship plus a build gate alone (R-05).
      return hasTestedUndo ? { kind: 'level', level: REVERSIBLE_REMEDIATION_CEILING } : NO_LEVEL;
    case 'merge':
    case 'forward_deploy':
    case 'irreversible':
      // Nothing to grant, ever, in this release (008 FR-024).
      return NO_LEVEL;
  }
}
