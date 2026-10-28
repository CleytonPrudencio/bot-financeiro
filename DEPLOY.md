# Deploy — Bot Financeiro

Na VM Hetzner (`77.42.120.142`), no padrão de sistema novo da VM: usuário de deploy restrito,
deploy automático pelo GitHub Actions, banco em rede interna, teto de recursos e backup diário.

| Container | O que é | Rede | Teto |
|---|---|---|---|
| `bot-app` | painel + API + webhook (Node) | `bot-financeiro_interna` + `saplink_default` (Caddy e internet) | 512 MB · 1 CPU |
| `bot-db` | PostgreSQL 16 | só `bot-financeiro_interna` (sem internet, sem Caddy) | 384 MB · 0,5 CPU |
| `bot-backup` | `pg_dump` diário, guarda 7 | só `bot-financeiro_interna` | 96 MB · 0,25 CPU |

| Item | Valor |
|---|---|
| URL | https://bot.77.42.120.142.sslip.io |
| Pasta na VM | `/opt/bot-financeiro` (o `.env` com os segredos vive aqui) |
| Projeto Docker | `bot-financeiro` |
| Usuário de deploy | `botdeploy` (`git-shell`, sudo só para `/opt/bot-financeiro-deploy/deploy.sh`) |
| Repo bare | `/home/botdeploy/bot-financeiro.git` |
| Volumes | `bot-financeiro_bot_db` (banco), `bot-financeiro_bot_backups` (7 dumps) |

Os comandos abaixo rodam no Git Bash do seu computador, na raiz deste repositório.

## Jeito automático (recomendado)

Um script faz toda a configuração inicial e o primeiro deploy, e pode rodar de novo sem estragar
nada (cada etapa confere se já foi feita):

```bash
bash scripts/publicar-na-vm.sh voce@exemplo.com
```

Ele cria as chaves de deploy, prepara a VM, publica, guarda uma cópia do `BOT_ENCRYPTION_KEY` em
`~/.ssh/bot-financeiro.encryption-key`, acrescenta o bloco no Caddy (backup, validação, e restaura o
arquivo se reprovar), espera o `/saude`, cria o seu usuário do painel (a senha aparece uma vez) e,
se o [GitHub CLI](https://cli.github.com) estiver instalado e logado, cadastra os segredos do
Actions para os próximos pushes publicarem sozinhos. Sem o GitHub CLI:

```bash
winget install --id GitHub.cli
```

```bash
gh auth login
```

e rode o script de novo. As seções abaixo são o mesmo passo a passo, à mão.

## Configuração inicial (uma vez)

### 1. Chaves de deploy

```bash
ssh-keygen -t ed25519 -C "bot-ci-github-actions" -f ~/.ssh/bot_ci -N ""
```

```bash
ssh-keygen -t ed25519 -C "bot-deploy" -f ~/.ssh/bot_deploy
```

A `bot_ci` vai para o GitHub (sem senha, só o CI usa). A `bot_deploy` é para deploy manual de
emergência (com senha).

### 2. Preparar a VM

Manda a pasta `deploy/` e as duas chaves **públicas** pela conexão SSH e roda o `setup-vm.sh` como
root (cria o `botdeploy`, o repo bare, o hook, o script de deploy e a regra de sudo):

```bash
tar czf - deploy -C ~/.ssh bot_ci.pub bot_deploy.pub | ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 'rm -rf /tmp/bot-setup && mkdir /tmp/bot-setup && tar xzmf - -C /tmp/bot-setup && bash /tmp/bot-setup/deploy/setup-vm.sh /tmp/bot-setup/bot_ci.pub /tmp/bot-setup/bot_deploy.pub; rm -rf /tmp/bot-setup'
```

Pode rodar de novo sem estragar nada (é assim que se leva uma mudança do `server-deploy.sh` ou do
`post-receive` para a VM).

### 3. GitHub

Em **Settings → Secrets and variables → Actions → New repository secret**:

| Nome | Valor |
|---|---|
| `BOT_DEPLOY_KEY` | conteúdo de `~/.ssh/bot_ci` (a chave **privada**) |
| `BOT_KNOWN_HOSTS` | saída de `ssh-keyscan 77.42.120.142` |

```bash
cat ~/.ssh/bot_ci
```

```bash
ssh-keyscan 77.42.120.142
```

Depois de cadastrar, apague a privada do CI do seu computador:

```bash
rm ~/.ssh/bot_ci
```

### 4. Primeiro deploy

Push na `main` (ou **Actions → deploy → Run workflow**). O primeiro deploy cria
`/opt/bot-financeiro/.env` com senha do banco, `BOT_SESSION_SECRET` e `BOT_ENCRYPTION_KEY`
aleatórios e `BOT_LIVE_ENABLED=false`.

**Guarde o `BOT_ENCRYPTION_KEY` no gerenciador de senhas**: sem ele, as chaves de API cadastradas
não abrem mais se o `.env` se perder.

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "grep BOT_ENCRYPTION_KEY /opt/bot-financeiro/.env"
```

### 5. Caddy

O Caddy é o compartilhado da VM (`saplink-caddy`, arquivo `/opt/saplink/deploy/Caddyfile`, bind de
arquivo único). Só **acrescentar**, nunca editor nem `sed -i`. Backup e acréscimo:

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 'cp /opt/saplink/deploy/Caddyfile /opt/saplink/deploy/Caddyfile.bak-$(date +%F)-bot && cat >> /opt/saplink/deploy/Caddyfile' < deploy/Caddyfile.bot
```

Validar (se reclamar, volte o backup antes de qualquer reload):

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "docker exec saplink-caddy caddy validate --config /etc/caddy/Caddyfile"
```

Aplicar:

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "docker exec saplink-caddy caddy reload --config /etc/caddy/Caddyfile"
```

### 6. Usuário do painel

Gera uma senha aleatória e mostra uma única vez:

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "docker exec bot-app node dist/scripts/criar-admin.js voce@exemplo.com"
```

O mesmo comando troca a senha de quem já existe.

## Deploy do dia a dia

Push na `main`. O workflow roda typecheck, testes (com Postgres), build e a montagem da imagem;
se tudo passar, faz `git push` para `botdeploy@77.42.120.142:bot-financeiro.git`, o hook chama o
`deploy.sh`, que faz `git archive` para `/opt/bot-financeiro` (preservando o `.env`) e
`docker compose up -d --build`. O workflow confere `https://bot.77.42.120.142.sslip.io/saude`.

Migrações (`migrations/*.sql`) rodam sozinhas na subida do `bot-app`. Migração aplicada não se
edita: cria-se a próxima (`002_...sql`).

### Deploy manual (Actions fora do ar)

```bash
git remote add deploy botdeploy@77.42.120.142:bot-financeiro.git
```

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/bot_deploy -o IdentitiesOnly=yes" git push deploy main
```

## Ligar o dinheiro real

Três chaves, todas necessárias. Faça só depois de semanas em simulação e na testnet.

1. **Servidor** — `BOT_LIVE_ENABLED=true` no `.env` e recriar o app:

   ```bash
   ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "cd /opt/bot-financeiro && sed -i 's/^BOT_LIVE_ENABLED=.*/BOT_LIVE_ENABLED=true/' .env && docker compose --env-file .env up -d bot-app"
   ```

2. **Conta** — no painel, Contas → Editar → modo Real, com chave de API **sem permissão de saque**.
3. **Estratégia** — no painel, Estratégias → "Operar real".

Para desligar tudo de uma vez, o botão **PARAR TUDO** do painel. Sem acesso ao painel:

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "docker exec bot-db psql -U bot bot -c \"update configuracoes set valor = 'true' where chave = 'parada_geral'\""
```

Último recurso (o webhook para de responder):

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "docker stop bot-app"
```

## Operação

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "docker ps --filter name=bot- --format '{{.Names}}  {{.Status}}'"
```

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "docker logs --tail 200 bot-app"
```

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "docker exec -it bot-db psql -U bot bot"
```

### Backup e restauração

O `bot-backup` grava um dump por dia em `bot-financeiro_bot_backups` e guarda os 7 mais recentes.
Ele fica **na mesma VM**: baixe uma cópia de tempos em tempos (o dump tem as chaves de API cifradas;
sem o `BOT_ENCRYPTION_KEY` elas não abrem, mas trate o arquivo como sensível).

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "docker exec bot-db pg_dump -U bot -Fc bot" > bot-$(date +%F).dump
```

Restaurar (apaga o que está no banco):

```bash
ssh -i ~/.ssh/saplink_hetzner root@77.42.120.142 "docker exec -i bot-db pg_restore -U bot -d bot --clean" < bot-AAAA-MM-DD.dump
```

## Isolamento

O bot divide a VM com outros sistemas, mas não divide nada além da entrada de tráfego:

- usuário de deploy próprio, com `git-shell` e uma única regra de sudo;
- pasta e projeto Docker próprios, teto de memória e CPU em todos os containers;
- o banco fica numa rede `internal` (sem internet e fora da rede do Caddy): nenhum outro sistema
  da VM alcança o banco do bot;
- nenhuma porta publicada no host;
- a limpeza de imagens do deploy só toca imagens deste projeto.
