# Bot Financeiro

Robô de operações: recebe **sinais externos** por webhook (TradingView ou qualquer sistema que faça
um `POST`), passa cada sinal por regras de risco e executa a ordem numa exchange de cripto. Tem
painel web para cadastrar contas e estratégias, ver sinais e ordens, e uma **parada geral**.

> ⚠️ **Começa em simulação e fica em simulação** até você ligar, de propósito, três chaves.
> Robô que opera sozinho pode perder dinheiro rápido: sinal errado, exchange instável ou um limite
> mal configurado. Rode semanas em simulação e na testnet antes de pôr dinheiro real, e só com
> valores que você aceita perder.

| Item | Valor |
|---|---|
| Stack | Node 22 + Express 5 + TypeScript, PostgreSQL 16 (SQL puro, sem ORM), painel em JS puro |
| Exchanges | qualquer uma das ~100 do [CCXT](https://github.com/ccxt/ccxt): Binance, Mercado Bitcoin, Bybit, OKX, Foxbit… |
| Testnet | Binance, Bybit e OKX têm; Mercado Bitcoin e Foxbit não |
| B3 (ações, futuros) | **não suportado ainda**: precisa de uma ponte com o MetaTrader 5 (ver [Próximos passos](#próximos-passos)) |
| Endereço | https://bot.77.42.120.142.sslip.io (VM Hetzner, atrás do Caddy compartilhado) |
| Deploy | push na `main` → GitHub Actions testa → `git push` para a VM → container novo ([DEPLOY.md](DEPLOY.md)) |

## Como funciona

```mermaid
flowchart LR
    tv[TradingView<br/>ou outra fonte] -->|POST /webhook/token| caddy[Caddy · TLS]
    caddy --> app[bot-app]
    app --> ler[1 · lê o sinal]
    ler --> trava[2 · trava a estratégia<br/>um sinal por vez]
    trava --> risco[3 · regras de risco]
    risco -->|rejeitado| reg[(sinais)]
    risco -->|aprovado| modo{simulação<br/>ou real?}
    modo -->|simulação| sim[preenche na cotação pública<br/>saldo de mentira]
    modo -->|real| ccxt[CCXT → exchange<br/>ordem a mercado]
    sim & ccxt --> grava[(ordens · posições · saldos)]
    painel[Painel web] --> app
```

### O sinal

O corpo pode ser JSON ou texto com JSON dentro (o TradingView manda `text/plain`). Só `acao` é
obrigatória:

```json
{"acao":"comprar","simbolo":"{{ticker}}","preco":{{close}},"id":"{{timenow}}"}
```

| Campo | Para quê |
|---|---|
| `acao` | `comprar` (`buy`, `long`), `vender` (`sell`) ou `zerar` (`close`, `exit`, `fechar`) |
| `simbolo` | par; aceita `BTC/USDT`, `BTCUSDT` e `BINANCE:BTCUSDT`. Tem que ser o da estratégia |
| `valor` | quanto gastar na compra, em moeda de cotação. Sem ele, vale o "valor por ordem" da estratégia |
| `quantidade` | quanto vender, em moeda base. Sem ele, `vender` vende a posição inteira |
| `preco` | preço que a fonte viu: serve para recusar sinal velho (desvio máximo) e para a simulação sem cotação |
| `id` | identificador único do alerta: o mesmo `id` nunca executa duas vezes |

A URL `…/webhook/<token>` é o que autoriza: trate como senha. O token aparece **uma vez** na
criação da estratégia (no banco fica só o hash) e pode ser trocado no painel.

### Regras de risco (nesta ordem)

1. **Parada geral** ligada → nada sai (nem venda).
2. Estratégia **desativada** → rejeita.
3. **IP** fora da lista da estratégia (se houver lista) → rejeita.
4. **Par** do sinal diferente do da estratégia → rejeita.
5. **Dinheiro real** só com as três chaves: `BOT_LIVE_ENABLED=true` no servidor, conta em modo
   real e estratégia marcada "real". Estratégia real sem alguma das outras → **rejeita** (nunca
   cai em simulação calada).
6. **Intervalo mínimo** entre ordens (menos para `zerar`).
7. **Desvio de preço**: `preco` do sinal longe da cotação atual → rejeita.
8. Compra: **limite por ordem**, **limite diário** (soma das compras do dia, fuso de São Paulo) e
   **limite da posição** aberta.
9. Venda: só o que a estratégia comprou (à vista, sem venda a descoberto).

Um sinal por vez por estratégia (trava no banco): dois alertas simultâneos não furam o limite. Todo
sinal fica gravado com a situação (`executado`, `rejeitado`, `ignorado`, `erro`) e o motivo.

### Simulação

Cada conta em simulação tem um **saldo de mentira** (definido no painel). A ordem é preenchida
inteira na cotação pública da exchange, com a taxa configurada e sem derrapagem: o resultado real
costuma ser um pouco pior.

### Chaves de API

Ficam no banco cifradas com AES-256-GCM usando `BOT_ENCRYPTION_KEY` (que não fica no banco) e nunca
voltam para o painel. Na exchange, crie a chave **sem permissão de saque** e, se der, restrita ao IP
`77.42.120.142`.

## Rodar local

Precisa de Node 22 e um Postgres 16.

```bash
cp .env.example .env
```

```bash
npm ci
```

```bash
npm run admin -- voce@exemplo.com
```

```bash
npm run dev
```

O painel abre em http://localhost:3000. O `admin` mostra a senha gerada uma única vez.

## Testes

```bash
npm test
```

Os testes de unidade cobrem as regras de risco, a leitura do sinal, a simulação e a cifra. O teste
de integração (painel → conta → estratégia → webhook → ordem, limites, parada geral, sinais
simultâneos) roda quando há um Postgres vazio para ele:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bot_teste npm test
```

O GitHub Actions roda os dois em todo push e pull request.

## Estrutura

```
src/
  server.ts            sobe: migra o banco e abre a porta
  app.ts               Express: segurança, /saude, /webhook, /api, painel
  motor.ts             processa um sinal: trava, risco, execução, registro
  risco.ts             regras de risco (função pura, testada)
  sinal.ts             leitura e normalização do sinal
  brokers/             ccxt.ts (exchanges reais e cotação pública), simulacao.ts
  routes/api.ts        API do painel (login, contas, estratégias, sinais, ordens, auditoria)
  routes/webhook.ts    POST /webhook/<token>
  crypto.ts            cifra das chaves de API e tokens
  scripts/criar-admin.ts
migrations/            SQL aplicado em ordem na subida
public/                painel (HTML, CSS, JS sem build)
deploy/                scripts da VM e bloco do Caddy
tests/
```

## Próximos passos

- **B3 via MetaTrader 5**: o MT5 só roda em Windows e a API dele é em Python. O caminho é uma ponte
  pequena (Python + `MetaTrader5`) num Windows com o terminal da corretora aberto, que expõe
  "comprar/vender/cotação" por HTTP com token; aqui entra como mais uma `Corretora`. Precisa de
  corretora com MT5 para pessoa física e conta demo para testar.
- **2FA no login do painel** antes de operar dinheiro real.
- Ordens limitadas, stop loss e take profit do lado da exchange.
- Notificação (e-mail ou Telegram) de ordem executada e de erro.
