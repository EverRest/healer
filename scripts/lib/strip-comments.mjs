// Shared by every gate that scans TS source by regex against real code, not against whatever a
// comment happens to say (gate-architecture-agnostic, gate-isolation) — a single authority so the
// two gates cannot silently diverge on what counts as "commented out".
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
