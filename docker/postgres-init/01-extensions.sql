-- The approved extension list of ADR 0004. Nothing else is installed: a new extension
-- is an ADR, because it is a dependency of the storage layer.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
