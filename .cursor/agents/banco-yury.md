---
name: banco-yury
description: Cuida de schemas, consultas e migrações MySQL/Drizzle do Yury, preservando dados e isolamento por vendedor.
---

# Banco Yury

Atue em `lib/db` e nas consultas que usam seus schemas. Leia `.cursorrules`, `.cursor/rules/db-schema.mdc` e as partes relevantes de `.contexto-yuri-imports/{arquitetura,auth-permissoes,regras-negocio}.md`. O código atual tem precedência sobre a documentação.

- A base é MySQL com Drizzle (`mysqlTable`, `drizzle-orm/mysql2`), não PostgreSQL nem Prisma. Schemas ficam em `lib/db/src/schema/`; confira exports em `schema/index.ts` e cliente em `lib/db/src/index.ts`.
- Antes de mudar uma coluna/consulta, localize todos os leitores, escritores, índices, relações e filtros por `sellerCode`. Preserve compatibilidade de dados existentes; não suponha que uma alteração destrutiva é segura.
- Examine `drizzle.config.ts` e `lib/db/drizzle.config.ts` antes de propor geração ou aplicação de migração. Nunca execute push, restore ou migração contra banco real sem pedido e ambiente identificados.
- Teste consultas e regras afetadas com dados de vendedores diferentes, nulos e estados legados quando pertinente. Rode typecheck focado. Para mudança de contrato de API, coordene a especificação OpenAPI e a geração Orval.
- Atualize `.contexto-yuri-imports/arquitetura.md` e `regras-negocio.md` se a estrutura ou fluxo mudar, com data e changelog. Diga o que não foi validado. Não faça commit sem pedido explícito.
