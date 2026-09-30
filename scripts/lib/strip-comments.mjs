// Shared by every gate that scans TS source by regex against real code, not against whatever a
// comment happens to say (gate-architecture-agnostic, gate-isolation, gate-graph-confirm-capability)
// — a single authority so the gates cannot silently diverge on what counts as "commented out".
//
// Built on the TypeScript compiler's own scanner (`typescript` is already a repo dependency, used
// for `tsc --build` — reusing it here is rung 5 of the ladder, not a new dependency) rather than a
// hand-rolled `.replace(/\/\/.*$/gm, '')`. The regex version was reproducibly defeated by an
// ordinary string literal earlier on the same line — `const base = "https://example.com"; ...` —
// because a naive regex cannot tell "this `/` starts a comment" from "this `/` is inside a string".
// A real tokenizer can: `ts.createScanner` classifies a string, template or regex literal as one
// token before comment detection ever sees the characters inside it, so `//` inside a URL string is
// never mistaken for a line comment (reproduced and fixed — see strip-comments.test.ts).
//
// `ts.createScanner`'s plain `scan()` does not, on its own, handle a template literal that contains
// a `${...}` substitution: after the `}` that closes the substitution expression, bare `scan()` has
// no way to know it should resume scanning template text rather than top-level code, and only
// `scanner.reScanTemplateToken()` does that correctly (this is why a real parser tracks a template
// stack — a bare scanner loop does not get this for free). Without tracking that, a file with any
// interpolated template literal — extremely common in this codebase's SQL and error-message
// strings — silently corrupted every token after the first `}` inside one, including turning a
// *later* JSDoc comment's backtick-quoted identifiers into bogus template tokens and leaving the
// whole comment unstripped (reproduced against `packages/domain/evidence/src/domain/
// evidence-required.ts`, fixed by the brace-depth tracking below).
//
// Comment trivia is replaced with blank space, **not** removed outright, so every newline the
// original source had is still present in the output — callers that report `path:line` (e.g.
// gate-graph-confirm-capability) can count `\n` in the stripped text and get the original file's
// line numbers, including across a multi-line block comment.
import ts from 'typescript';

const COMMENT_KINDS = new Set([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
]);

export function stripComments(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source,
  );
  let out = '';
  // One counter per currently-open template substitution, tracking `{`/`}` nesting *inside* that
  // substitution expression — so the `}` that actually closes the substitution (counter at 0) is
  // told apart from a `}` closing an object literal or block written inside it.
  const templateBraceDepth = [];

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.TemplateHead) {
      templateBraceDepth.push(0);
    } else if (templateBraceDepth.length > 0 && token === ts.SyntaxKind.OpenBraceToken) {
      templateBraceDepth[templateBraceDepth.length - 1] += 1;
    } else if (templateBraceDepth.length > 0 && token === ts.SyntaxKind.CloseBraceToken) {
      const top = templateBraceDepth.length - 1;
      if (templateBraceDepth[top] === 0) {
        // This `}` ends the substitution, not a nested block — resume as template text.
        token = scanner.reScanTemplateToken(false);
        if (token === ts.SyntaxKind.TemplateTail) templateBraceDepth.pop();
      } else {
        templateBraceDepth[top] -= 1;
      }
    }

    const text = scanner.getTokenText();
    // Comment trivia becomes its own newlines only, so line numbers in the result still match the
    // original file; every other token (code, whitespace, string/template/regex literals) passes
    // through verbatim — a literal is one token here, never re-examined character by character.
    out += COMMENT_KINDS.has(token) ? text.replace(/[^\n]/g, '') : text;
  }
  return out;
}
