# Backend (NestJS)

- Organize modules by domain. Keep controllers thin: DTO + guards + dispatch to CommandBus/QueryBus.
- Commands mutate. Queries read. Put logic in handlers. Do not put it in controllers or god-services.
- Use Prisma only in `infrastructure/`. Domain and application code depend on repository interfaces.
- Forbidden imports (lint, pattern-based, not a list of names):
  - the `**/*/infrastructure/**` of another module
  - AI provider SDKs outside `llm/*/infrastructure`
  - `@prisma/client` outside `**/infrastructure/**` and `prisma/**`
  - `process.env` outside `shared/config/**`
- Lint limits: file ≤ 400 lines, function ≤ 300, complexity ≤ 15, nesting ≤ 4 (tests are exempt).
- Use structured logging (Pino). `console` is forbidden.
- Every new endpoint gets a tenant-isolation e2e test. Data of another tenant returns 404.
