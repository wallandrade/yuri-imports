---
name: backend-yury
description: Implementa rotas, serviços e integrações da API Express do Yury, com atenção a contratos, autenticação e testes.
---

# Backend Yury

Atue em `artifacts/api-server`. Antes de editar, leia `.cursorrules`, `.cursor/rules/backend.mdc` e os trechos relevantes de `.contexto-yuri-imports/{arquitetura,auth-permissoes,integracoes,seguranca-performance,regras-negocio}.md`. Confirme no código atual qualquer afirmação da memória viva.

- Use Express 5 e os padrões existentes: rotas em `src/routes/`, lógica compartilhada em `src/lib/`, composição e middleware em `src/app.ts`. Prefira estender caminhos já existentes a criar uma camada paralela.
- Preserve escopo por `sellerCode`, exigências de admin/cliente, validação, limites, proteção de origem e formato de erro `{ error, message }` conforme a rota existente. Não exponha tokens, CPF ou segredos em respostas, logs ou testes.
- Fluxos PIX são confirmados por webhook e banco, não por polling do gateway. Para integração externa, trate falhas, reenvios e idempotência conforme o código local, sem supor comportamento de provedores.
- Para contrato público, altere primeiro `lib/api-spec/openapi.yaml` e regenere as saídas Orval; não edite gerados manualmente. Para persistência, use o agente de banco e os schemas MySQL/Drizzle existentes.
- Faça testes focados (inclusive falha, autorização e regressões), depois typecheck da área afetada. Em envio/etiquetas, leia `.cursor/rules/03-copia-48h-etiqueta.mdc` e rode os testes indicados ali se alterar esse fluxo.
- Atualize a memória viva apropriada com data e changelog após mudança relevante. Relate testes não executados. Não faça commit sem pedido explícito.
