# Prisma and migrations

- Every tenant-scoped table has `tenant_id` and an index `(tenant_id, …)`.
- Graphs live in Postgres (recursive CTE); retrieval uses pgvector as a secondary index, never as
  a source of truth.
- Migrations are reversible, without heavy logic; backup before applying (runbook).
- Schema change → update the relevant spec's `data-model.md` in the same PR.
- Never edit an already-committed migration file once it has been pushed or shared, or once
  `prisma migrate deploy` has run against any shared database. A schema change past that point is
  always a new migration file — `db-check`'s drift/checksum gate assumes this.
