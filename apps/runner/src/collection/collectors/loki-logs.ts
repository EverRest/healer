import { z } from 'zod';
import type { Collector, CollectorOutput, Candidate, SourcePort, Unrecognised } from './types.js';
import { isoTimestamp, parseRecords } from './helpers.js';

const rawLog = z.object({ line: z.string(), timestamp: isoTimestamp, locator: z.string() });

const ERROR_LEVELS = new Set(['ERROR', 'FATAL', 'CRITICAL']);
const KNOWN_LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'WARNING', ...ERROR_LEVELS]);
const TEXT_FORMAT = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?\s+([A-Z]+)\s+([\s\S]*)$/;
const PYTHON_FRAME = /^\s*File "(.+?)", line (\d+), in (\S+)\s*$/;
// `app/` is both a deployment directory (`/srv/app/src/…`) and a framework one, so it is tried last.
const REPO_ROOTS =
  /(?:^|\/)((?:src|lib|apps|packages|test|tests|internal|cmd|pkg|services|server|client)\/.+)$/;
const APP_ROOT = /(?:^|\/)(app\/.+)$/;
const MAX_FRAMES = 10;
// Bounds on what the frame parser will look at: a hostile line costs a bounded scan, not a stalled loop.
const MAX_STACK_LINES = 200;
const MAX_LINE_CHARS = 400;

interface ParsedLog {
  readonly level: string;
  readonly message: string;
  readonly stack: readonly string[];
}

/** The two formats ruleset v1 recognises: JSON-lines with level + message, and `<iso> LEVEL message`. */
function parseLine(line: string): ParsedLog | undefined {
  if (line.startsWith('{')) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const message = o.message ?? o.msg;
      if (typeof o.level !== 'string' || typeof message !== 'string') return undefined;
      const stack = typeof o.stack === 'string' ? o.stack.split('\n') : [];
      return { level: o.level.toUpperCase(), message, stack };
    } catch {
      return undefined;
    }
  }
  const m = TEXT_FORMAT.exec(line);
  if (m === null) return undefined;
  const [head = '', ...rest] = (m[2] ?? '').split('\n');
  return { level: m[1] ?? '', message: head, stack: rest };
}

/** Repository-relative, or nothing: an absolute path outside a known root leaks a directory layout. */
function repoRelativePath(path: string): string | undefined {
  const clean = path.replace(/^file:\/\//, '');
  const root = (REPO_ROOTS.exec(clean) ?? APP_ROOT.exec(clean))?.[1];
  if (root === undefined || root.includes('node_modules/')) return undefined;
  return /^[\w@$.+/-]+$/.test(root) ? root : undefined;
}

/** `at symbol (path:line:col)` / `at path:line:col`, parsed from the end with no nested quantifiers. */
function nodeFrame(
  raw: string,
): { path: string; line: number; symbol?: string | undefined } | undefined {
  const text = raw.slice(0, MAX_LINE_CHARS).trim();
  if (!text.startsWith('at ')) return undefined;
  let rest = text.slice(3).trim();
  let symbol: string | undefined;
  if (rest.endsWith(')')) {
    const open = rest.lastIndexOf(' (');
    if (open > 0) symbol = rest.slice(0, open);
    rest = rest.slice(open > 0 ? open + 2 : rest.startsWith('(') ? 1 : 0, -1);
  }
  const at = /:(\d+):\d+$/.exec(rest);
  return at === null ? undefined : { path: rest.slice(0, at.index), line: Number(at[1]), symbol };
}

function frames(lines: readonly string[]): { path: string; symbol: string; line: number }[] {
  const out: { path: string; symbol: string; line: number }[] = [];
  for (const raw of lines.slice(0, MAX_STACK_LINES)) {
    const py = PYTHON_FRAME.exec(raw.slice(0, MAX_LINE_CHARS));
    const found =
      nodeFrame(raw) ??
      (py ? { path: py[1] ?? '', line: Number(py[2]), symbol: py[3] } : undefined);
    const path = found === undefined ? undefined : repoRelativePath(found.path);
    if (found === undefined || path === undefined || found.line < 1) continue;
    const symbol = found.symbol;
    out.push({
      path,
      line: found.line,
      symbol:
        symbol !== undefined && /^[A-Za-z_$<][\w$.<>[\] ]{0,100}$/.test(symbol)
          ? symbol
          : '<anonymous>',
    });
    if (out.length === MAX_FRAMES) break;
  }
  return out;
}

function exceptionType(message: string): string {
  return /\b([A-Z][A-Za-z0-9_$]*(?:Error|Exception))\b/.exec(message)?.[1] ?? 'UnknownError';
}

/**
 * `loki_logs` (003 T016): an error record becomes an `error_signature` and its stack frames
 * `stack_frame`s — closed-form fields parsed out of the line, never the line itself. The message
 * rides only as the raw text an excerpt may be cleared from; `clear.ts` decides whether any of it
 * crosses. A line in no recognised format is `Unrecognised` and is withheld.
 */
export function lokiLogsCollector(source: SourcePort): Collector {
  return {
    key: 'loki_logs',
    async collect(invocation, ctx): Promise<CollectorOutput> {
      const { component, environment } = invocation.parameters as {
        component: string;
        environment: string;
      };
      const records = await source.read({
        component,
        environment,
        window: ctx.window,
        limit: ctx.maxItems + 1,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const { parsed, unrecognised } = parseRecords(rawLog, records, 'error_signature', ctx);
      const candidates: (Candidate | Unrecognised)[] = [...unrecognised];
      let capped = false;
      for (const record of parsed) {
        const log = parseLine(record.line);
        if (log === undefined || !KNOWN_LEVELS.has(log.level)) {
          candidates.push({
            kind: 'unrecognised',
            itemClass: 'error_signature',
            observedAt: new Date(record.timestamp),
            sourceLocator: record.locator,
            original: record.line,
          });
          continue;
        }
        if (!ERROR_LEVELS.has(log.level)) continue; // not an error signal; the adapter's filter owns selection
        if (candidates.length >= ctx.maxItems) {
          capped = true;
          break;
        }
        const observedAt = new Date(record.timestamp);
        const stack = frames(log.stack);
        candidates.push({
          kind: 'candidate',
          itemClass: 'error_signature',
          evidence: {
            kind: 'error_signature',
            exceptionType: exceptionType(log.message),
            frames: stack.map((f) => `${f.path}:${f.line}`),
            component,
            environment,
          },
          observedAt,
          sourceLocator: record.locator,
          rawText: log.message,
          guardText: record.line,
        });
        stack.forEach((f, frameIndex) =>
          candidates.push({
            kind: 'candidate',
            itemClass: 'stack_frame',
            evidence: {
              kind: 'stack_frame',
              path: f.path,
              symbolName: f.symbol,
              line: f.line,
              frameIndex,
            },
            observedAt,
            sourceLocator: record.locator,
            guardText: record.line,
          }),
        );
      }
      return { candidates, capped };
    },
  };
}
