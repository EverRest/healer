# Prisma and migrations

- Every tenant-scoped table has `tenant_id` and an index `(tenant_id, …)`.
- Graphs live in Postgres (recursive CTE); retrieval uses pgvector as a secondary index, never as
  a source of truth.
- Migrations are reversible, without heavy logic; backup before applying (runbook).
- Schema change → update the relevant spec's `data-model.md` in the same PR.
