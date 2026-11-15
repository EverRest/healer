# Prisma and migrations

- Every tenant-scoped table has `tenant_id` and an index `(tenant_id, …)`.
- Graphs live in Postgres (recursive CTE). Retrieval uses pgvector as a secondary index. It is never
  a source of truth.
- Migrations are reversible and contain no heavy logic. Make a backup before you apply one (runbook).
- If the schema changes, update the `data-model.md` of the related spec in the same PR.
- Never edit a migration file that is already committed, after it is pushed or shared, or after
  `prisma migrate deploy` has run against any shared database. After that point, a schema change is
  always a new migration file. The drift/checksum gate of `db-check` depends on this.
