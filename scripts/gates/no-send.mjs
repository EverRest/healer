#!/usr/bin/env node
// `gate-no-send` (012 T082, 009 SC-005): no package outside the egress allowlist imports an
// outbound mail, SMS, chat or HTTP-client module capable of sending to a human.
//
// Scoped monorepo-wide, not to the support packages: 009's adapters live under `integrations/` by
// design, so a support-send adapter added there would trip nothing if the rule only watched
// support packages by name — the allowlist below is the single, explicit, reviewable list of
// exceptions, and it names no support package (contracts/make-targets.md).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Outbound-to-a-human channels. Not a general HTTP-client ban (fetch/axios reach APIs
// constantly, including read-only ones) — the closed list of packages that exist specifically to
// deliver mail, SMS or chat messages to a person.
const OUTBOUND_SEND_MODULES = [
  'nodemailer',
  'twilio',
  '@sendgrid/mail',
  '@slack/web-api',
  '@slack/bolt',
  'discord.js',
  'node-telegram-bot-api',
  'whatsapp-web.js',
];

// The single, reviewable exception list (FR-005 — this is what a boundary-exceptions.md entry
// would exempt). Empty today: AutoSupport (009) proposes, something else sends, and no adapter
// has been written yet — see contracts/make-targets.md's gate-no-send row.
const EGRESS_ALLOWLIST = [];

function isAllowed(relativePath) {
  return EGRESS_ALLOWLIST.some((prefix) => relativePath.startsWith(prefix));
}

/* v8 ignore start -- CLI wiring (real fs walk); findUnallowedSendImports below is unit tested */
function* walkTsFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walkTsFiles(full);
    else if (extname(entry) === '.ts' && !entry.endsWith('.test.ts')) yield full;
  }
}

/* v8 ignore stop */

/** @param {{ path: string, content: string }[]} files */
export function findUnallowedSendImports(files) {
  const issues = [];
  const pattern = new RegExp(
    `from\\s+['"](${OUTBOUND_SEND_MODULES.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})['"]`,
  );
  for (const { path, content } of files) {
    if (isAllowed(path)) continue;
    const match = content.match(pattern);
    if (match)
      issues.push(`${path}: imports ${match[1]}, not on the egress allowlist (009 SC-005)`);
  }
  return issues;
}

/* v8 ignore start -- CLI wiring; findUnallowedSendImports above is unit tested */
if (isMainModule(import.meta.url)) {
  const result = await runGate('gate-no-send', () => {
    const files = [
      ...walkTsFiles(join(REPO_ROOT, 'packages')),
      ...walkTsFiles(join(REPO_ROOT, 'apps')),
    ].map((path) => ({ path: relative(REPO_ROOT, path), content: readFileSync(path, 'utf8') }));
    const issues = findUnallowedSendImports(files);
    if (issues.length > 0) throw new Error(issues.join('; '));
  });
  reportAndExit(result);
}
/* v8 ignore stop */
