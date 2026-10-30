-- Opções binárias na Quotex, a pedido do dono e por conta e risco dele. A Quotex não tem API
-- oficial: quem fala com ela é a ponte no Windows do dono (public/ponte-quotex/ponte.py), com a
-- biblioteca pyquotex, o login dele e a internet de casa. A ponte liga para o bot (só sai conexão),
-- manda velas, payout e saldo, e pega as apostas que o bot já aprovou. A senha da Quotex nunca vem
-- para o bot; a conta "quotex" se identifica com um token (só o hash fica aqui, como na ponte MT5).
--
-- Simulação aqui = conta DEMO da Quotex (aposta de verdade, com saldo de treino). Real = as três
-- chaves de sempre (BOT_LIVE_ENABLED, conta real, estratégia real) e a ponte configurada para real.

alter table contas drop constraint contas_check;
alter table contas add constraint contas_check check (
  modo = 'simulacao'
  or exchange = 'b3'
  or (exchange in ('mt5', 'quotex') and ponte_token_hash is not null)
  or (api_key_cifrada is not null and api_secret_cifrada is not null)
);

-- ativos que a ponte manda: velas de 1 min, payout e se está aberto (igual para toda conta Quotex)
create table quotex_mercado (
  ativo         text primary key,            -- nome da Quotex: EURUSD, BTCUSD_otc...
  nome          text,                        -- como aparece na tela: "EUR/USD (OTC)"
  aberto        boolean not null default false,
  payout_1m     numeric(6,2),                -- % de lucro se acertar, em 1 min
  payout_5m     numeric(6,2),
  velas         jsonb not null default '[]', -- [[t_ms, abre, max, min, fecha], ...] de 1 min
  atualizado_em timestamptz not null default now()
);

-- uma estratégia de binárias: um ativo, um prazo, um valor fixo por aposta e os limites do dia
create table binarias (
  id                bigserial primary key,
  nome              text not null,
  conta_id          bigint not null references contas(id),
  ativo             text not null,
  ativa             boolean not null default false,
  real              boolean not null default false,  -- terceira chave do dinheiro real
  estilo            text not null default 'repique' check (estilo in ('repique', 'tendencia')),
  prazo_s           integer not null default 300 check (prazo_s in (60, 120, 180, 300)), -- a ponte espera o resultado até 5 min
  valor             numeric(14,2) not null check (valor > 0),
  payout_min        numeric(6,2) not null default 85 check (payout_min between 50 and 100),
  max_apostas_dia   integer not null default 10 check (max_apostas_dia between 1 and 200),
  perda_max_dia     numeric(14,2) not null check (perda_max_dia > 0),
  perdas_seguidas_max integer not null default 3 check (perdas_seguidas_max between 1 and 20),
  intervalo_min_seg integer not null default 300 check (intervalo_min_seg >= 0),
  situacao          text,                            -- o que o robô pensou na última vela
  checado_em        timestamptz,
  criado_em         timestamptz not null default now()
);

-- cada aposta: do pedido ao resultado
create table apostas (
  id            bigserial primary key,
  binaria_id    bigint not null references binarias(id) on delete cascade,
  conta_id      bigint not null references contas(id),
  modo          text not null check (modo in ('simulacao', 'real')),
  ativo         text not null,
  direcao       text not null check (direcao in ('call', 'put')),
  valor         numeric(14,2) not null,
  prazo_s       integer not null,
  payout        numeric(6,2) not null,             -- payout que valia ao pedir
  motivo        text,
  situacao      text not null default 'pendente'
                check (situacao in ('pendente', 'enviada', 'aberta', 'ganhou', 'perdeu', 'empate', 'erro', 'expirada')),
  id_quotex     text,
  lucro         numeric(14,2),                     -- líquido: + o ganho, - o valor apostado, 0 no empate
  retorno       numeric(14,2),                     -- o "profit" que a Quotex devolveu, como veio
  erro          text,
  criada_em     timestamptz not null default now(),
  enviada_em    timestamptz,
  aberta_em     timestamptz,
  terminada_em  timestamptz
);
create index apostas_binaria_ix on apostas (binaria_id, criada_em desc);
create index apostas_pendentes_ix on apostas (conta_id) where situacao = 'pendente';
-- uma aposta em andamento por estratégia, garantido pelo banco
create unique index apostas_uma_por_vez_uk on apostas (binaria_id) where situacao in ('pendente', 'enviada', 'aberta');
