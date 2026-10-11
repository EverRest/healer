import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * Static disagreement corpus (005 SC-006; quickstart scenarios 17 and 18): the wiki says five
 * retries, the code says three, the traces say three, and the adopted expectation says four — what
 * checkout SHOULD do. Fixtures only — retrieval code lives elsewhere. Every value is derived from
 * the fixture files, never hard-coded here, so the self-check proves the files encode the
 * disagreement.
 */
export const FIXTURE_FILES = [
  'wiki-checkout.md',
  'payment-retry.ts.txt',
  'expectations/checkout.md',
  'observations.json',
] as const;

// CRLF-normalised so a checkout with autocrlf reads the same corpus.
const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const num = (text: string, re: RegExp, file: string): number => {
  const m = re.exec(text);
  if (!m?.[1]) throw new Error(`disagreement corpus: ${String(re)} not found in ${file}`);
  return Number(m[1]);
};

const wiki = read('wiki-checkout.md');
const code = read('payment-retry.ts.txt');
const expectations = read('expectations/checkout.md');
/** Boundary `trace_shape` evidence records, one per observed checkout trace. */
const observations = JSON.parse(read('observations.json')) as {
  kind: 'trace_shape';
  spans: { name: string }[];
}[];

const block = /^---\n([\s\S]*?)\n---/.exec(expectations);
if (!block?.[1]) throw new Error('front matter not found in expectations/checkout.md');
const frontMatter = parse(block[1], { uniqueKeys: true }) as {
  constraints: { max_payment_retries: { value: number } };
};

const retriesPerTrace = observations.map(
  (t) => t.spans.filter((s) => s.name === 'payment.authorize.retry').length,
);
const observed = retriesPerTrace[0];
if (observed === undefined || retriesPerTrace.some((n) => n !== observed)) {
  throw new Error(`disagreement corpus: traces disagree on retries: ${retriesPerTrace.join(',')}`);
}

export const disagreementCorpus = { wiki, code, expectations, observations } as const;

/** Each source's answer to "how many retries does checkout do". */
export const claims = {
  wiki: num(wiki, /up to (\d+) times/, 'wiki-checkout.md'),
  code: num(code, /MAX_PAYMENT_RETRIES = (\d+)/, 'payment-retry.ts.txt'),
  traces: retriesPerTrace,
} as const;

export const groundTruth = {
  /** "how many retries does checkout do" — observation wins for current behaviour. */
  currentBehaviorRetries: observed,
  /** "how many should it" — the adopted expectation's value. */
  intendedBehaviorRetries: frontMatter.constraints.max_payment_retries.value,
} as const;
