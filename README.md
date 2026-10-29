# Bot Financeiro

Robô de operações: recebe **sinais externos** por webhook (TradingView ou qualquer sistema que faça
um `POST`), passa cada sinal por regras de risco e executa a ordem numa exchange de cripto. Tem
painel web para cadastrar contas e estratégias, ver sinais e ordens, e uma **parada geral**. Dá
para ligar **quantas IAs quiser** (Claude, ChatGPT, Gemini, Ollama…) para dar parecer antes de cada
ordem, e uma **mesa de análise com 5 agentes de IA** que dá nota de 0 a 100 a um ativo.

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
| Deploy | primeira vez: `bash scripts/publicar-na-vm.sh voce@exemplo.com`; depois, push na `main` → GitHub Actions testa → `git push` para a VM ([DEPLOY.md](DEPLOY.md)) |

## Como funciona

```mermaid
flowchart LR
    tv[TradingView<br/>ou outra fonte] -->|POST /webhook/token| caddy[Caddy · TLS]
    caddy --> app[bot-app]
    app --> ler[1 · lê o sinal]
    ler --> trava[2 · trava a estratégia<br/>um sinal por vez]
    trava --> risco[3 · regras de risco]
    risco -->|rejeitado| reg[(sinais)]
    risco -->|aprovado| nota[4 · nota da análise<br/>se a estratégia exige]
    nota -->|abaixo| reg
    nota --> ia[5 · parecer das IAs<br/>se a estratégia pede]
    ia -->|barrou| reg
    ia --> modo{simulação<br/>ou real?}
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

## IAs

Página **IAs** do painel: cada conector é um modelo de um provedor.

| Provedor | Como conecta |
|---|---|
| Claude (Anthropic) | SDK oficial `@anthropic-ai/sdk`; Opus 5.5, Sonnet 5.5 ou Haiku 5.5; resposta em JSON estruturado; se o modelo recusar por política, a API refaz o pedido no modelo reserva recomendado (`fallbacks: "default"`) |
| ChatGPT, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, qualquer outro | API no formato da OpenAI (`/chat/completions`): muda só a URL base, o modelo e a chave |
| Ollama da VM | `http://saplink-ollama:11434/v1` (mesma rede do Caddy), sem chave e sem custo; cuidado: ele já é o processo mais pesado da VM |

A chave fica cifrada como as das exchanges e nunca volta para o painel; fora da rede interna, só
`https`. **A IA só pode barrar**: roda depois das regras de risco, não cria ordem, não muda valor e
`zerar` nunca passa por ela. Em cada estratégia:

| Campo | O quê |
|---|---|
| Modo | `desligado`, `consultivo` (grava o parecer, não barra) ou `obrigatório` (pode barrar) |
| Aprovações necessárias | quantas IAs precisam aprovar (vazio = todas as consultadas) |
| Confiança mínima | aprovação abaixo disto não conta |
| Se uma IA falhar | conta como não aprovou, ou sai da conta. Obrigatório sem conector ativo não deixa sair nada |
| Consultar nas vendas | por padrão só compras passam pela IA |

O parecer de cada IA fica gravado no sinal (página **Sinais**, clique na linha). A página IAs também
tem **Perguntar a todas**: a mesma pergunta vai para as IAs escolhidas ao mesmo tempo.

## Mesa de análise (5 agentes)

Página **Análises**: cinco agentes de IA dão nota a um ativo, cada um com 5 subnotas de 0 a 20 —
**técnico** (25%), **fundamental** (25%), **sentimento** (20%), **risco** (15%) e **tese** (15%) —
e a soma ponderada vira a nota de 0 a 100 com conceito (A+ a F) e sinal (Compra forte… Evitar).
Os indicadores (médias 20/50/200, IFR, MACD, Bollinger, ATR, volatilidade, quedas, força contra o
BTC) são calculados aqui a partir das velas diárias da exchange, não "achados" pela IA. Nos
conectores Claude dá para ligar a pesquisa na web (notícias, dados do projeto ou da empresa).

A estratégia pode exigir **nota mínima** de uma análise recente do par para **comprar** (venda nunca
depende dela). Os agentes, as réguas e os pesos são adaptados do projeto
[ai-trading-claude](https://github.com/zubair-trabzada/ai-trading-claude) (licença MIT; aviso em
`src/analise/LICENCA-ai-trading-claude.txt`), traduzidos e ajustados para cripto. É pesquisa e
educação, não recomendação de investimento.

## Escritório virtual

Página **Escritório** do painel: um escritório animado (Canvas, sem biblioteca) com **um robô
analista para cada mercado** — cripto (Bitcoin, Ethereum, Solana, XRP), B3 (Petrobras, Vale,
Ibovespa), câmbio (Dólar, Euro), commodities (Ouro, Petróleo Brent) e bolsa americana (S&P 500) —,
cada um com o gráfico do seu ativo no monitor. Quando um analista vê um sinal (cruzamento das médias
9 e 26, stop ou alvo), leva a proposta até o **robô chefe**, que confere de novo (tendência longa,
IFR, volatilidade, exposição total, sequência de perdas). Os dois juntam as notas (45% analista, 55%
chefe, mínimo 60%, veto do chefe reprova sozinho) e, se aprovado, o analista volta e executa.

**Escala do dia**: na lateral você escolhe quem trabalha hoje (um a um ou pelos atalhos "Só cripto",
"Só B3", "Brasil", "Lotar as mesas", "Todos de folga"). São 8 mesas; quem fica de folga vai andando
para a **sala de descanso** (sofá e pufes, cochilando) ou para o **cantinho do café**. Quem é
dispensado com posição aberta zera antes de sair; quem está em reunião sai quando voltar para a
mesa. A escala fica salva no navegador.

Por enquanto **o mercado é fictício** (`public/escritorio/mercado.js`) e nenhuma ordem sai dali.
Ligando o **Conselho de IAs** na lateral, cada proposta também vai para as IAs de verdade
(`POST /api/ias/parecer`, gasta créditos); elas só podem vetar, e stop e alvo nunca são vetados. Para ligar
em dados reais, troque a fonte do mercado e a execução por chamadas à API do bot; a lógica de
decisão está separada do desenho em `public/escritorio/decisao.js` (testada em
`tests/escritorio.test.ts`).

| Arquivo | O quê |
|---|---|
| `public/escritorio/mercado.js` | mercado fictício com regimes de alta/baixa, horário da B3 e do câmbio, indicadores |
| `public/escritorio/decisao.js` | proposta do analista, verificação do chefe, decisão conjunta, carteira |
| `public/escritorio/desenho.js` | cenário, mesas, monitores, robôs, balões, holograma, partículas |
| `public/escritorio/escritorio.js` | coreografia (fila, reunião, volta), laço de animação e painel lateral |

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

Os testes de unidade cobrem as regras de risco, o parecer das IAs, os indicadores e a nota da
análise, a leitura do sinal, a simulação e a cifra. O de integração usa uma IA falsa local no formato
da OpenAI. O teste
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
  risco.ts             regras de risco, parecer das IAs e nota da análise (funções puras, testadas)
  ia/                  conectores de IA: anthropic.ts (SDK oficial), compativel.ts (formato OpenAI), prompt.ts
  analise/             mesa de 5 agentes: agentes.ts, indicadores.ts, nota.ts, index.ts
  sinal.ts             leitura e normalização do sinal
  brokers/             ccxt.ts (exchanges reais e cotação pública), simulacao.ts
  routes/api.ts        API do painel (login, contas, estratégias, sinais, ordens, auditoria)
  routes/webhook.ts    POST /webhook/<token>
  crypto.ts            cifra das chaves de API e tokens
  scripts/criar-admin.ts
migrations/            SQL aplicado em ordem na subida
public/                painel (HTML, CSS, JS sem build): app.js, js/base.js, js/paginas/*, escritorio/*
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
- Reanalisar sozinho, de tempos em tempos, os pares das estratégias que exigem nota mínima.
