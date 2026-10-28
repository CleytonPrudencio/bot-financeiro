# CLAUDE.md — Bot Financeiro

Robô de operações: sinais por webhook → regras de risco → ordem numa exchange (CCXT), com painel
web. Leia o [README](README.md) para o funcionamento e o [DEPLOY](DEPLOY.md) para a VM.
Escreva em português do Brasil, código e comentários inclusive.

## Regras

1. **Dinheiro real é opt-in triplo** (`BOT_LIVE_ENABLED`, conta real, estratégia real). Nenhuma
   mudança pode criar um caminho que mande ordem real sem as três, nem cair em simulação calado
   quando a estratégia pede real. Toda regra nova de risco vai em `src/risco.ts` (função pura) com
   teste em `tests/risco.test.ts`.
2. **Nada de segredo em log, resposta ou repositório.** Chaves de API só cifradas (`src/crypto.ts`)
   e nunca devolvidas pela API; token de webhook só como hash; o log mascara o token no caminho.
3. **Um sinal por vez por estratégia**: o `processarSinal` trava a estratégia no banco
   (`pg_advisory_xact_lock`). Não tire a trava nem leia o estado fora dela.
4. **Depois que a exchange aceitou a ordem**, o log `ordem executada` é a prova dela: mantenha esse
   log antes de qualquer gravação no banco.
5. Painel sem `innerHTML` com dado de fora: monte com `h()` (usa `textContent`). CSP é só `'self'`.
6. Toda chamada que muda algo na API precisa do cabeçalho `X-Painel: 1` (CSRF).
7. Migração aplicada não se edita: nova em `migrations/NNN_nome.sql`.

## Comandos

```bash
npm run typecheck
```

```bash
npm test
```

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bot_teste npm test
```

O teste de integração **apaga e recria** o banco de `TEST_DATABASE_URL`: use um banco só para ele.

## VM

Roda na VM Hetzner compartilhada (`77.42.120.142`) — tudo sobre ela está no repositório
`CleytonPrudencio/vm-hetzner-infra` e no agente `vm-hetzner`. O que vale aqui:

- containers `bot-app`, `bot-db`, `bot-backup`; projeto `bot-financeiro`; pasta `/opt/bot-financeiro`;
- domínio `bot.77.42.120.142.sslip.io` no Caddy compartilhado (só `cat >>`, ver DEPLOY.md);
- nunca `docker compose down -v` (apaga o banco); nunca porta publicada no host.
