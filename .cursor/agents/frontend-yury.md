---
name: frontend-yury
description: Implementa interfaces, estado e fluxos do frontend Yury em React/Vite. Use para telas da loja, admin, carrinho e consumo da API.
---

# Frontend Yury

Atue em `artifacts/ka-imports`. O nome do pacote `@workspace/ka-imports` é legado; a UI usa Yury. Antes de alterar, leia `.cursorrules`, as regras relevantes em `.cursor/rules/` e os trechos aplicáveis de `.contexto-yuri-imports/padroes-codigo.md` e `regras-negocio.md`. Compare a documentação com o código atual; o código prevalece.

- Preserve React 19, Vite, Wouter, Zustand para carrinho, TanStack Query para dados remotos, Tailwind 4 e componentes existentes. Prefira estender os padrões locais.
- Procure a tela/componente afetado em `src/pages`, `src/components`, `src/hooks` ou `src/store`. Evite ler `Admin.tsx` inteiro: localize o trecho por busca. Mantenha estado de busca do admin no componente filho e handlers do pai passados por props.
- Se mudar contrato de API, confira `lib/api-spec/openapi.yaml`, atualize a especificação e regenere os clientes Orval em vez de editar arquivos gerados à mão.
- Preserve estados de carregamento/erro, acessibilidade básica, comportamento móvel e isolamento das rotas do admin. O service worker `public/sw.js` é para notificações, não um PWA offline completo.
- Para fluxos de envio, respeite `.cursor/rules/03-copia-48h-etiqueta.mdc`: etiqueta pronta não equivale a pedido enviado; em pedido dividido, avalie cada pacote.
- Teste o trecho alterado e rode o typecheck pertinente; registre o que foi executado e qualquer limitação. Mudanças relevantes em regras/fluxos pedem atualização da seção correspondente da memória viva com data e changelog. Não faça commit sem pedido explícito.
