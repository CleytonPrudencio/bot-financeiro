-- Esquema inicial do robô de operações.
-- Valores de dinheiro em numeric(30,12): cripto tem até 8–18 casas, e soma de ordens não pode
-- perder centavo por arredondamento de ponto flutuante dentro do banco.

create table usuarios (
  id          bigserial primary key,
  email       text not null unique,
  senha_hash  text not null,
  criado_em   timestamptz not null default now(),
  ultimo_login timestamptz
);

-- Configuração global (uma linha por chave). A "parada_geral" bloqueia qualquer ordem.
create table configuracoes (
  chave       text primary key,
  valor       jsonb not null,
  alterado_em timestamptz not null default now()
);
insert into configuracoes (chave, valor) values ('parada_geral', 'false');

-- Uma conta numa exchange. Em modo "simulacao" usa só cotação pública e um saldo de mentira;
-- em modo "real" usa as chaves (cifradas) para mandar ordens de verdade.
create table contas (
  id              bigserial primary key,
  nome            text not null,
  exchange        text not null,                 -- id do CCXT: binance, mercado, bybit...
  modo            text not null default 'simulacao' check (modo in ('simulacao', 'real')),
  testnet         boolean not null default false, -- sandbox da exchange (Binance tem)
  api_key_cifrada text,
  api_secret_cifrada text,
  api_senha_cifrada  text,                       -- algumas exchanges pedem "password"
  taxa_simulada_pct numeric(8,4) not null default 0.1,
  criado_em       timestamptz not null default now(),
  check (modo = 'simulacao' or (api_key_cifrada is not null and api_secret_cifrada is not null))
);

-- Saldo de mentira das contas em simulação.
create table saldos_simulados (
  conta_id   bigint not null references contas(id) on delete cascade,
  moeda      text not null,
  quantidade numeric(30,12) not null check (quantidade >= 0),
  primary key (conta_id, moeda)
);

-- Uma estratégia recebe sinais de uma fonte (TradingView etc.) para um par numa conta.
create table estrategias (
  id                  bigserial primary key,
  nome                text not null,
  conta_id            bigint not null references contas(id),
  simbolo             text not null,             -- formato CCXT: BTC/USDT, BTC/BRL
  ativa               boolean not null default false,
  real                boolean not null default false, -- terceira chave do dinheiro real
  token_hash          text not null unique,      -- sha256 do token do webhook; o token não fica no banco
  token_prefixo       text not null,             -- 6 primeiros caracteres, só para reconhecer no painel
  valor_ordem         numeric(30,12) not null check (valor_ordem > 0),   -- em moeda de cotação (USDT, BRL)
  limite_por_ordem    numeric(30,12) not null check (limite_por_ordem > 0),
  limite_diario       numeric(30,12) not null check (limite_diario > 0), -- soma das compras do dia
  limite_posicao      numeric(30,12),            -- custo máximo da posição aberta (opcional)
  intervalo_min_seg   integer not null default 60 check (intervalo_min_seg >= 0),
  desvio_max_pct      numeric(8,4) not null default 1.0, -- preço do sinal x cotação atual
  ips_permitidos      text,                      -- lista separada por vírgula; vazio = qualquer
  criado_em           timestamptz not null default now()
);

-- Posição que a estratégia comprou e ainda não vendeu (só à vista, sem venda a descoberto).
create table posicoes (
  estrategia_id bigint primary key references estrategias(id) on delete cascade,
  quantidade    numeric(30,12) not null default 0 check (quantidade >= 0),
  custo_total   numeric(30,12) not null default 0 check (custo_total >= 0),
  atualizada_em timestamptz not null default now()
);

-- Todo sinal recebido fica registrado, aceito ou não, com o motivo.
create table sinais (
  id              bigserial primary key,
  estrategia_id   bigint references estrategias(id) on delete set null,
  id_externo      text,                          -- "id" enviado pela fonte, para não repetir
  acao            text,
  corpo           jsonb not null,
  ip              text,
  situacao        text not null check (situacao in ('executado', 'rejeitado', 'ignorado', 'erro')),
  motivo          text,
  recebido_em     timestamptz not null default now()
);
create unique index sinais_id_externo_uk on sinais (estrategia_id, id_externo) where id_externo is not null;
create index sinais_recebido_em_ix on sinais (recebido_em desc);

create table ordens (
  id               bigserial primary key,
  estrategia_id    bigint not null references estrategias(id),
  conta_id         bigint not null references contas(id),
  sinal_id         bigint references sinais(id) on delete set null,
  modo             text not null check (modo in ('simulacao', 'real')),
  simbolo          text not null,
  lado             text not null check (lado in ('compra', 'venda')),
  quantidade       numeric(30,12) not null,      -- moeda base (BTC)
  preco_medio      numeric(30,12) not null,
  custo            numeric(30,12) not null,      -- moeda de cotação (USDT, BRL)
  taxa             numeric(30,12) not null default 0,
  id_exchange      text,
  situacao         text not null check (situacao in ('executada', 'erro')),
  erro             text,
  criada_em        timestamptz not null default now()
);
create index ordens_estrategia_dia_ix on ordens (estrategia_id, criada_em desc);

-- Auditoria de quem mudou o quê no painel (parada geral, modo real, chaves, limites).
create table eventos (
  id         bigserial primary key,
  usuario_id bigint references usuarios(id) on delete set null,
  tipo       text not null,
  detalhe    jsonb not null default '{}',
  criado_em  timestamptz not null default now()
);
create index eventos_criado_em_ix on eventos (criado_em desc);
