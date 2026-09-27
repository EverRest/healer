// Re-exports the generated Prisma client (custom `output`, so it is its own package, not
// `node_modules/@prisma/client` — ADR 0013) so every `infrastructure/` folder depends on one
// stably-named workspace package instead of a `link:` path to a build artifact.
export * from '@healer/prisma-generated';
