# Backup diário da mídia (R2) e aviso de atraso

O bucket `clayton-assets` guarda a mídia da loja (fotos de produto, etiquetas, imagens do admin, PDF da EnvioEcom e o resto que a API sobe). Ele continua sendo a origem. Este job só lista e lê esse bucket. Não há `Put`, `Copy` com destino nele, nem `Delete`.

O destino é o bucket privado que já recebe o dump do MySQL, `yuri-imports-db-backups`, no prefixo `media/`. Um bucket novo exigiria outra regra de ciclo de vida e outro token. O prefixo separa a mídia dos dumps `mysql/`. A condição é a regra de 30 dias do bucket valer **somente** para `mysql/`. Se ela valer no bucket inteiro, o espelho da mídia some 30 dias depois da cópia.

## Por que não copiar o bucket inteiro todo dia

A primeira execução copia cada objeto uma vez para `media/mirror/<chave original>`. Nas seguintes, a comparação é etag + tamanho, gravados em `media/state/manifest.json`:

- igual, e o espelho ainda está lá: não copia
- igual no manifesto, mas o espelho sumiu: copia de novo (não perde o arquivo se uma regra de ciclo de vida apagar o espelho)
- etag diferente: o espelho atual vai para `media/history/AAAA-MM-DD/HHMM/<etag>/<chave>` e a versão nova entra no espelho. A chave leva hora e etag e a cópia usa `If-None-Match`, então não sobrescreve
- sumiu na origem: a última cópia vai para esse histórico e o espelho permanece

Um arquivo apagado ou substituído na loja continua em `media/history/`. O padrão é **sem expiração**: o job não apaga espelho, histórico, manifesto nem marca. `MEDIA_BACKUP_RETENTION_DAYS` com um inteiro de 1 a 3650 passa a apagar só `media/history/` e `media/runs/` mais velhos que esse prazo. `0`, `none`, `off`, `never` ou vazio voltam para sem expiração. O espelho e o prefixo `mysql/` não entram nessa limpeza. O andamento de uma execução interrompida fica em diários pequenos em `media/state/journal/`; o manifesto inteiro só é gravado no fim.

A marca de sucesso é `media/runs/YYYY-MM-DD_HHmm.json`. Sem ela, o vigilante trata a mídia como atrasada.

Sem `MEDIA_BACKUP_SOURCE_PREFIXES`, a origem é o bucket inteiro. `uploadBufferToR2` aceita qualquer pasta, e essa pasta entra na cópia. As pastas que a API grava hoje são `products/`, `tracking-labels/`, `admin-images/`, `envioecom-labels/`, `whatsapp-groups/`, `site-settings/` e `uploads/`. Com a variável preenchida, um prefixo da raiz que não esteja na lista faz o job falhar e avisar.

## Variáveis

Obrigatórias no job `media-backup-r2`:

- `CLOUDFLARE_R2_ACCOUNT_ID` — o mesmo account id do dump. O endpoint é `https://<id>.r2.cloudflarestorage.com`
- `MEDIA_BACKUP_SOURCE_R2_ACCESS_KEY_ID` e `MEDIA_BACKUP_SOURCE_R2_SECRET_ACCESS_KEY` — token com **Object Read só** em `clayton-assets`. Sem escrita nesse bucket
- `MEDIA_BACKUP_DEST_R2_ACCESS_KEY_ID` e `MEDIA_BACKUP_DEST_R2_SECRET_ACCESS_KEY` — token com leitura e escrita **só** em `yuri-imports-db-backups`. Não serve para ler a loja. Não há token único para os dois buckets
- `BACKUP_ALERT_PHONE` — **esta variável é o destino do aviso.** Celular do dono, só dígitos, DDI `55`, sem hífen. O número não vai no repositório. Espaço e parêntese são aceitos; hífen não. Um id de grupo (`…-…` ou `@g.us`) é recusado e nenhuma mensagem sai. Se a Z-API recusar ou não responder, o job grava `[backup-alert] Z-API não enviou o aviso` no log, sem token e sem URL
- `ZAPI_MAIN_INSTANCE_ID`, `ZAPI_MAIN_TOKEN`, `ZAPI_CLIENT_TOKEN` — instância principal que a loja já usa. O aviso é `POST /send-text` em `https://api.z-api.io`, direto, sem n8n e sem grupo

Opcionais:

- `MEDIA_BACKUP_SOURCE_BUCKET` — só `clayton-assets`. Outro nome é recusado
- `MEDIA_BACKUP_DEST_BUCKET` — só `yuri-imports-db-backups`. Outro nome, inclusive o bucket da loja, é recusado
- `MEDIA_BACKUP_DEST_PREFIX` — padrão `media/`. Tem que começar com `media/`
- `MEDIA_BACKUP_SOURCE_PREFIXES` — vazio copia o bucket inteiro, então uma pasta nova entra sozinha. Com lista, um prefixo da raiz que não esteja nela faz o job falhar e avisar, em vez de ficar de fora em silêncio
- `MEDIA_BACKUP_RETENTION_DAYS` — padrão vazio, **sem expiração**. Inteiro de 1 a 3650 apaga só histórico e marcas. Não apaga `media/mirror/` nem `mysql/`
- `BACKUP_TIME_ZONE` — padrão `America/Sao_Paulo`, usado no nome do histórico e da marca
- `BACKUP_S3_ENDPOINT` / `BACKUP_S3_REGION` — iguais ao dump, se não for R2
- `MEDIA_BACKUP_DRY_RUN=1` — só lista e imprime o plano. Não grava marca de sucesso

O vigilante (`backup-watchdog`) lê o bucket de backup com o token próprio `BACKUP_WATCHDOG_R2_*` (Object Read). Não usa o token do dump (`BACKUP_R2_*`), que também apaga dumps antigos:

- `BACKUP_WATCHDOG_R2_ACCESS_KEY_ID` e `BACKUP_WATCHDOG_R2_SECRET_ACCESS_KEY` — **Object Read só** em `yuri-imports-db-backups`. Não usa `BACKUP_R2_*`, que escreve
- `BACKUP_R2_BUCKET`, `CLOUDFLARE_R2_ACCOUNT_ID`
- `BACKUP_ALERT_PHONE` e as três `ZAPI_MAIN_*` / `ZAPI_CLIENT_TOKEN`
- `BACKUP_STALE_HOURS` — padrão `26`, entre 20 e 48. Idade maior ou igual a isso dispara o aviso
- `BACKUP_KEY_PREFIX` — padrão `mysql/`, o mesmo do dump
- `MEDIA_BACKUP_DEST_PREFIX` — se o prefixo da mídia não for `media/`

Canal do texto: WhatsApp da Z-API para o número em `BACKUP_ALERT_PHONE`, instância `ZAPI_MAIN_*`. Sem n8n. E-mail da Brevo fica na tabela `site_settings` e não serve quando o MySQL está fora. O segundo canal é o e-mail de alerta do App Platform, ligado no painel (abaixo). O spec público não tem a regra “Failed job invocation”; `DEPLOYMENT_FAILED` existe, mas este repositório não guarda o app spec. Um arquivo parcial aplicado no app substituiria o que está no ar, então o e-mail não entra num yaml daqui.

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

`backup-watchdog`, cron `0 6 * * *` com `time_zone: America/Sao_Paulo`. Isso é 06:00 em Brasília, não 06:00 UTC (UTC seria 09:00). O App Platform usa o fuso do campo `time_zone`, não o UTC do servidor:

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

O dump continua `0 3 * * *` e a mídia `30 3 * * *`, os dois com `time_zone: America/Sao_Paulo` (03:00 e 03:30 em Brasília, 06:00 e 06:30 UTC). O vigilante às 06:00 de Brasília vê um dump das 03:00 com 3 horas. Se o das 03:00 não rodou, o de ontem tem 27 horas e ele avisa. Um WhatsApp de falha de dump, mídia ou vigilante no mesmo dia (marca `media/state/alerts/AAAA-MM-DD.json`) não é repetido às 06:00; o job ainda sai com código 1 para o e-mail da DigitalOcean. Aviso de limpeza dos dumps antigos não grava essa marca: o dump em si já foi salvo e o processo sai com código 0.

No job `db-backup-r2` que já existe, acrescente `BACKUP_ALERT_PHONE`, `ZAPI_MAIN_INSTANCE_ID`, `ZAPI_MAIN_TOKEN` e `ZAPI_CLIENT_TOKEN` como SECRET de runtime. O comando de execução não muda.

## Passo a passo no painel (não dá para fazer daqui)

1. Cloudflare R2 → bucket `yuri-imports-db-backups` → Settings → Object lifecycle. Exclusão de 30 dias **só no prefixo `mysql/`**. `media/` não entra. Uploads multipart incompletos podem continuar em 7 dias.
2. O token de destino (`MEDIA_BACKUP_DEST_R2_*`) tem **Delete** no bucket de backup. Por isso o histórico precisa de trava no painel: o R2 **não** implementa versionamento S3 (`PutBucketVersioning` está fora da API). No bucket `yuri-imports-db-backups`, Settings → **Bucket locks**: uma regra com prefixo `media/history/` e condição Indefinite (ou Age longa) impede apagar ou sobrescrever o histórico, mesmo com esse token. Não tranque `mysql/` com prazo maior que 30 dias, senão a limpeza dos dumps não consegue apagar. Não tranque o bucket inteiro.
3. Três tokens, separados. Object Read **somente** em `clayton-assets` (`MEDIA_BACKUP_SOURCE_R2_*`). Object Read & Write, com Delete, **somente** em `yuri-imports-db-backups` (`MEDIA_BACKUP_DEST_R2_*`). Object Read somente no bucket de backup, para o vigilante (`BACKUP_WATCHDOG_R2_*`). Não cole no git.
4. App Platform → app `yuri-imports` → Create Resources → Job → Scheduled Job.
   - Nome `media-backup-r2`. Repositório `wallandrade/yuri-imports`, branch `main`, source `/`. Build igual ao do dump. Run command `pnpm --filter @workspace/scripts backup:media:r2`. Cron `30 3 * * *`, time zone `America/Sao_Paulo`. Tamanho `apps-s-1vcpu-1gb`.
   - Envs SECRET: `CLOUDFLARE_R2_ACCOUNT_ID`, `MEDIA_BACKUP_SOURCE_R2_ACCESS_KEY_ID`, `MEDIA_BACKUP_SOURCE_R2_SECRET_ACCESS_KEY`, `MEDIA_BACKUP_DEST_R2_ACCESS_KEY_ID`, `MEDIA_BACKUP_DEST_R2_SECRET_ACCESS_KEY`, `BACKUP_ALERT_PHONE`, `ZAPI_MAIN_INSTANCE_ID`, `ZAPI_MAIN_TOKEN`, `ZAPI_CLIENT_TOKEN`.
5. Outro job, nome `backup-watchdog`. Run command `pnpm --filter @workspace/scripts backup:watchdog`. Cron `0 6 * * *` com time zone `America/Sao_Paulo` (06:00 em Brasília, não UTC). Mesmo tamanho. Envs SECRET: `CLOUDFLARE_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET` = `yuri-imports-db-backups`, `BACKUP_WATCHDOG_R2_ACCESS_KEY_ID`, `BACKUP_WATCHDOG_R2_SECRET_ACCESS_KEY` (Object Read só nesse bucket), mais `BACKUP_ALERT_PHONE` e as três da Z-API.
6. No job `db-backup-r2`, as quatro variáveis do aviso (`BACKUP_ALERT_PHONE` e as três da Z-API). O valor do telefone é o do dono, informado separadamente. Não cole neste repositório.
7. E-mail da DigitalOcean, no app `yuri-imports` → **Settings** → **Alert Policies** → **Edit**:
   - Ligue **Failed deployment** (deploy falhou). O e-mail padrão da conta já cobre deploy novo.
   - Ligue **Failed job invocation** (job falhou). É o aviso quando `db-backup-r2`, `media-backup-r2` ou `backup-watchdog` saem com código 1. O vigilante sai com 1 se o backup não rodou nas últimas 26h, então o e-mail também pega “não rodou”, no dia seguinte às 6h.
   - Método: **Email**. O destino tem que ser um membro do time com acesso ao app. Confira se o e-mail do dono está na lista. Slack não entra.
   - **Save**.
   Isso não dá para declarar com segurança no spec do repositório: a regra de job falho não está no enum do app spec, e não há `.do/` com o spec completo do app.

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
