#!/usr/bin/env node
// `gate-data-model` (012 T076, FR-015, R-10, quickstart 29): a change set altering the database
// schema fails unless a specification's data-model.md changed in the same change set.
//
// This does not verify it is the *right* data-model.md for the schema change made — attributing
// a schema.prisma edit to the one owning spec would need a table→spec mapping this repository
// does not maintain anywhere yet. What it does check, mechanically: schema changed, no data model
// anywhere changed → fail. That is still real, still closes the "changed the schema, forgot the
// docs" gap FR-015 names, and is honest about what it does not further verify.
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';
import { changedFilesSinceBase } from '../lib/changed-files.mjs';

const SCHEMA_PATH = 'prisma/schema.prisma';
const DATA_MODEL_PATTERN = /^specs\/[^/]+\/data-model\.md$/;

export function findMissingDataModelUpdate(changedFiles) {
  if (!changedFiles.includes(SCHEMA_PATH)) return null;
  const dataModelChanged = changedFiles.some((f) => DATA_MODEL_PATTERN.test(f));
  if (dataModelChanged) return null;
  return `${SCHEMA_PATH} changed but no specs/*/data-model.md changed in the same change set (FR-015)`;
}

/* v8 ignore start -- CLI wiring; findMissingDataModelUpdate above is unit tested */
if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-data-model', () => {
    const issue = findMissingDataModelUpdate(changedFilesSinceBase());
    if (issue) throw new Error(issue);
  });
  reportAndExit(result);
}
/* v8 ignore stop */
