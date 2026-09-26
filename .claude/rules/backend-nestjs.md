# Backend (NestJS)

- Modules by domain; controllers are thin: DTO + guards + dispatch to CommandBus/QueryBus.
- Commands mutate, queries read; logic in handlers, not in controllers or god-services.
- Prisma only in `infrastructure/`; domain and application depend on repository interfaces.
- Forbidden imports (lint, pattern-based, not a name list):
  - another module's `**/*/infrastructure/**`
  - AI provider SDKs outside `llm/*/infrastructure`
  - `@prisma/client` outside `**/infrastructure/**` and `prisma/**`
  - `process.env` outside `shared/config/**`
- Lint limits: file ≤ 400 lines, function ≤ 300, complexity ≤ 15, nesting ≤ 4 (tests exempt).
- Structured logging (Pino); `console` is forbidden.
- Every new endpoint gets a tenant-isolation e2e test: another tenant's data returns 404.
