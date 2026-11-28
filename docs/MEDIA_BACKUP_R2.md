# Backup diário da mídia (R2) e aviso de atraso

O bucket `clayton-assets` guarda a mídia da loja (fotos de produto, etiquetas, imagens do admin, PDF da EnvioEcom e o resto que a API sobe). Ele continua sendo a origem. Este job só lista e lê esse bucket. Não há `Put`, `Copy` com destino nele, nem `Delete`.

O destino é o bucket privado que já recebe o dump do MySQL, `yuri-imports-db-backups`, no prefixo `media/`. Um bucket novo exigiria outra regra de ciclo de vida e outro token. O prefixo separa a mídia dos dumps `mysql/`. A condição é a regra de 30 dias do bucket valer **somente** para `mysql/`. Se ela valer no bucket inteiro, o espelho da mídia some 30 dias depois da cópia.

## Por que não copiar o bucket inteiro todo dia

A primeira execução copia cada objeto uma vez para `media/mirror/<chave original>`. Nas seguintes, a comparação é etag + tamanho, gravados em `media/state/manifest.json`:

- igual, e o espelho ainda está lá: não copia
- igual no manifesto, mas o espelho sumiu: copia de novo (não perde o arquivo se uma regra de ciclo de vida apagar o espelho)
- etag diferente: o espelho atual vai para `media/history/YYYY-MM-DD/<chave>` e a versão nova entra no espelho
- sumiu na origem: a última cópia vai para o histórico do dia e sai do espelho

Um arquivo apagado ou substituído na loja continua em `media/history/` até a retenção (padrão 30 dias). O histórico mais velho que isso é apagado pelo próprio job, só debaixo de `media/history/` e `media/runs/`. O manifesto é regravado a cada 40 arquivos, então um job interrompido no dia seguinte continua de onde parou em vez de baixar tudo de novo.

A marca de sucesso é `media/runs/YYYY-MM-DD_HHmm.json`. Sem ela, o vigilante trata a mídia como atrasada.

Prefixos de origem, por padrão: `products/`, `tracking-labels/`, `admin-images/`, `envioecom-labels/`, `whatsapp-groups/`, `site-settings/`, `uploads/`. São as pastas que `artifacts/api-server/src/lib/r2.ts` e a etiqueta EnvioEcom gravam.

## Variáveis

Obrigatórias no job `media-backup-r2`:

- `CLOUDFLARE_R2_ACCOUNT_ID` — o mesmo account id do dump. O endpoint é `https://<id>.r2.cloudflarestorage.com`
- `MEDIA_BACKUP_R2_ACCESS_KEY_ID` e `MEDIA_BACKUP_R2_SECRET_ACCESS_KEY` — token com **leitura** em `clayton-assets` e **leitura e escrita** em `yuri-imports-db-backups`. Não reutilize o token estreito do dump se ele não lê o bucket da loja. Se o painel da Cloudflare só deixar o mesmo nível nos dois buckets, use Read & Write nos dois: o script recusa escrita quando o destino é o bucket de origem
- `BACKUP_ALERT_WHATSAPP` — **esta variável é o destino do aviso.** Celular do dono, só dígitos, DDI `55`, sem hífen (`5535999999999`). Também aceita espaço e parêntese (`+55 (35) 999999999`). Um id de grupo (`5535…-1525…` ou `@g.us`) é recusado e nenhuma mensagem sai
- `ZAPI_MAIN_INSTANCE_ID`, `ZAPI_MAIN_TOKEN`, `ZAPI_CLIENT_TOKEN` — instância principal que a loja já usa. O aviso é `POST /send-text` em `https://api.z-api.io`, direto, sem n8n e sem grupo

Opcionais:

- `MEDIA_BACKUP_SOURCE_BUCKET` — padrão `clayton-assets`
- `MEDIA_BACKUP_DEST_BUCKET` — padrão `BACKUP_R2_BUCKET` ou `yuri-imports-db-backups`
- `MEDIA_BACKUP_DEST_PREFIX` — padrão `media/`. Tem que começar com `media/`
- `MEDIA_BACKUP_SOURCE_PREFIXES` — lista separada por vírgula. Vazio é erro, para não varrer o bucket sem querer
- `MEDIA_BACKUP_RETENTION_DAYS` — padrão `30` (inteiro de 1 a 3650). O dia exato do corte fica; só some o que é mais velho
- `BACKUP_TIME_ZONE` — padrão `America/Sao_Paulo`, usado no nome do histórico e da marca
- `BACKUP_S3_ENDPOINT` / `BACKUP_S3_REGION` — iguais ao dump, se não for R2
- `MEDIA_BACKUP_DRY_RUN=1` — só lista e imprime o plano. Não grava marca de sucesso

O vigilante (`backup-watchdog`) lê o bucket de backup com o token que o dump já usa:

- `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_R2_BUCKET`, `CLOUDFLARE_R2_ACCOUNT_ID`
- `BACKUP_ALERT_WHATSAPP` e as três `ZAPI_MAIN_*` / `ZAPI_CLIENT_TOKEN`
- `BACKUP_STALE_HOURS` — padrão `26`, entre 20 e 48. Idade maior ou igual a isso dispara o aviso
- `BACKUP_KEY_PREFIX` — padrão `mysql/`, o mesmo do dump
- `MEDIA_BACKUP_DEST_PREFIX` — se o prefixo da mídia não for `media/`

Canal: WhatsApp da Z-API para o número em `BACKUP_ALERT_WHATSAPP`. E-mail da Brevo fica na tabela `site_settings` e não serve quando o MySQL está fora. O job também sai com código 1, então um alerta de job falho no painel do DigitalOcean (App → Insights → Alerts, se a conta tiver) é um segundo sinal, opcional. Não há chamada a n8n.

Sem o número ou sem a instância, o vigilante sai com código 1 mesmo com os backups em dia, para o silêncio não parecer que está tudo certo. O dump e a cópia da mídia, se terminarem bem, não falham por causa do aviso.

## Jobs no App Platform

Não há spec `.do/` no repositório. O dump `db-backup-r2` foi criado no painel (veja `docs/DB_BACKUP_R2.md`). Os dois jobs novos seguem o mesmo modelo, no app `yuri-imports`, branch `main`, source directory `/`, environment Node.js, build `CI=true pnpm install --frozen-lockfile --prod=false`, tamanho `apps-s-1vcpu-1gb`.

`media-backup-r2`, cron `30 3 * * *`, fuso `America/Sao_Paulo`:

```yaml
jobs:
  - name: media-backup-r2
    kind: SCHEDULED
    schedule:
      cron: "30 3 * * *"
      time_zone: America/Sao_Paulo
    run_command: pnpm --filter @workspace/scripts backup:media:r2
    instance_size_slug: apps-s-1vcpu-1gb
```

`backup-watchdog`, cron `0 6 * * *`, fuso `America/Sao_Paulo`:

```yaml
jobs:
  - name: backup-watchdog
    kind: SCHEDULED
    schedule:
      cron: "0 6 * * *"
      time_zone: America/Sao_Paulo
    run_command: pnpm --filter @workspace/scripts backup:watchdog
    instance_size_slug: apps-s-1vcpu-1gb
```

O dump continua `0 3 * * *`. Às 6h, um dump das 3h tem 3 horas. Se o dump das 3h não rodou, o de ontem tem 27 horas e o vigilante avisa. O mesmo vale para a marca `media/runs/`.

No job `db-backup-r2` que já existe, acrescente `BACKUP_ALERT_WHATSAPP`, `ZAPI_MAIN_INSTANCE_ID`, `ZAPI_MAIN_TOKEN` e `ZAPI_CLIENT_TOKEN` como SECRET de runtime. O comando de execução não muda.

## Passo a passo no painel (não dá para fazer daqui)

1. Cloudflare R2 → bucket `yuri-imports-db-backups` → Settings → Object lifecycle. Deixe a exclusão de 30 dias **só no prefixo `mysql/`**. Confira que `media/` não entra nessa regra. Uploads multipart incompletos podem continuar em 7 dias no bucket.
2. Crie um API token da conta com Object Read em `clayton-assets` e Object Read & Write em `yuri-imports-db-backups`. Guarde o Access Key ID e o Secret. Não cole no git.
3. App Platform → app `yuri-imports` → Create Resources → Job → Scheduled Job.
   - Nome `media-backup-r2`. Repositório `wallandrade/yuri-imports`, branch `main`, source `/`. Build igual ao do dump. Run command `pnpm --filter @workspace/scripts backup:media:r2`. Cron `30 3 * * *`, time zone `America/Sao_Paulo`. Tamanho `apps-s-1vcpu-1gb`.
   - Envs SECRET: `CLOUDFLARE_R2_ACCOUNT_ID`, `MEDIA_BACKUP_R2_ACCESS_KEY_ID`, `MEDIA_BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_ALERT_WHATSAPP`, `ZAPI_MAIN_INSTANCE_ID`, `ZAPI_MAIN_TOKEN`, `ZAPI_CLIENT_TOKEN`.
4. Outro job, nome `backup-watchdog`. Run command `pnpm --filter @workspace/scripts backup:watchdog`. Cron `0 6 * * *`, o mesmo fuso e o mesmo tamanho. Envs SECRET: `CLOUDFLARE_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET` = `yuri-imports-db-backups`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY` (o token do dump já lê esse bucket), mais `BACKUP_ALERT_WHATSAPP` e as três da Z-API.
5. No job `db-backup-r2`, as quatro variáveis do aviso (`BACKUP_ALERT_WHATSAPP` e as três da Z-API).
6. Opcional: no app, um alerta de job falho para o e-mail da conta DigitalOcean. O WhatsApp continua sendo o aviso que enxerga “não rodou”.

Nada disso altera pedido, PIX ou estoque. Deploy do app só passa a valer depois do merge na `main` e do próximo build dos jobs. Esta mudança não publica nem faz merge.

## Rodar na mão

```
pnpm --filter @workspace/scripts backup:media:r2
MEDIA_BACKUP_DRY_RUN=1 pnpm --filter @workspace/scripts backup:media:r2
pnpm --filter @workspace/scripts backup:watchdog
```

O dry-run lista origem e destino e não grava a marca. Não use dry-run no cron.

## Restaurar um arquivo

O script baixa para um arquivo local. Não escreve no R2.

Versão atual do espelho:

```
MEDIA_RESTORE_KEY=products/abc/foto.jpg \
MEDIA_RESTORE_OUTPUT=/tmp/foto.jpg \
pnpm --filter @workspace/scripts restore:media:r2
```

Versão do dia em que foi trocada ou apagada (o histórico guarda a cópia anterior):

```
MEDIA_RESTORE_KEY=products/abc/foto.jpg \
MEDIA_RESTORE_DAY=2026-11-20 \
MEDIA_RESTORE_OUTPUT=/tmp/foto-antiga.jpg \
pnpm --filter @workspace/scripts restore:media:r2
```

As chaves de leitura são `MEDIA_BACKUP_R2_*` ou, se essas não existirem, `BACKUP_R2_*`, mais `CLOUDFLARE_R2_ACCOUNT_ID`. Para devolver o arquivo à loja, suba de novo pelo admin ou copie o arquivo local para `clayton-assets` na chave original, no painel da Cloudflare. Não há comando neste repositório que grave de volta no bucket da loja.

Dump do MySQL: continue em `docs/DB_BACKUP_R2.md`. O restore do banco recusa qualquer database cujo nome não contenha `test`.
