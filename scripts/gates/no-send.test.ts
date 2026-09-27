import { describe, expect, it } from 'vitest';
import { findUnallowedSendImports } from './no-send.mjs';

describe('gate-no-send (012 T082, 009 SC-005)', () => {
  it('fails a support-send adapter under packages/integrations — scoping to support packages was the original defeatable gap', () => {
    const issues = findUnallowedSendImports([
      {
        path: 'packages/integrations/support-send/src/index.ts',
        content: "import nodemailer from 'nodemailer';\nexport const send = nodemailer;\n",
      },
    ]);
    expect(issues).toEqual([
      'packages/integrations/support-send/src/index.ts: imports nodemailer, not on the egress allowlist (009 SC-005)',
    ]);
  });

  it('fails any package, not only ones named "support"', () => {
    const issues = findUnallowedSendImports([
      {
        path: 'packages/domain/policy/src/index.ts',
        content: "import { WebClient } from '@slack/web-api';\nexport { WebClient };\n",
      },
    ]);
    expect(issues).toHaveLength(1);
  });

  it('is silent on ordinary code importing nothing send-capable', () => {
    const issues = findUnallowedSendImports([
      {
        path: 'packages/domain/issues/src/index.ts',
        content: 'export interface Issue { id: string }',
      },
    ]);
    expect(issues).toEqual([]);
  });
});
