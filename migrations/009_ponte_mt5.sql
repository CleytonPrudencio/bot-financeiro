-- Ponte MetaTrader 5: ações da B3 por uma corretora com MT5 (ex.: XP). Um programa no Windows do
-- dono (public/ponte-mt5/ponte.py) liga para o bot, manda cotações, velas e saldo, e pega as ordens
-- que o bot já aprovou. A conta "mt5" não tem chave de API: quem autoriza a ponte é um token
-- (só o hash fica no banco, como o do webhook).

alter table contas
  add column ponte_token_hash    text unique,
  add column ponte_token_prefixo text,
  add column ponte_visto_em      timestamptz,
  -- o que a ponte informou da conta: corretora, servidor, saldo, posições (sem senha nenhuma)
  add column ponte_info          jsonb;

alter table contas drop constraint contas_check;
alter table contas add constraint contas_check check (
  modo = 'simulacao'
  or (exchange = 'mt5' and ponte_token_hash is not null)
  or (api_key_cifrada is not null and api_secret_cifrada is not null)
);

-- cotações e velas que a ponte manda (iguais para toda conta MT5: é o mercado da B3)
create table mt5_mercado (
  simbolo           text primary key,        -- formato do bot: PETR4/BRL
  cotacao           numeric(30,12),
  volume_financeiro numeric(30,2),           -- giro do dia em R$
  velas             jsonb not null default '{}', -- { "15m": [[t, abre, max, min, fecha, volume], ...], "1d": [...] }
  atualizado_em     timestamptz not null default now()
);

-- ordens que o bot mandou para a ponte (já aprovadas pelas regras, pelo agente e pelas três chaves)
create table mt5_comandos (
  id           bigserial primary key,
  conta_id     bigint not null references contas(id) on delete cascade,
  dados        jsonb not null,              -- { lado, simbolo, quantidade, preco_ref }
  situacao     text not null default 'pendente' check (situacao in ('pendente', 'enviado', 'feito', 'erro', 'expirado')),
  resultado    jsonb,
  criado_em    timestamptz not null default now(),
  enviado_em   timestamptz,
  terminado_em timestamptz
);
create index mt5_comandos_pendentes_ix on mt5_comandos (conta_id) where situacao = 'pendente';

-- ações que a ponte acompanha (a varredura do piloto olha estas): as mais negociadas e ETFs
insert into configuracoes (chave, valor) values ('mt5_universo', '["PETR4","VALE3","ITUB4","BBDC4","BBAS3","ABEV3","WEGE3","B3SA3","PRIO3","ELET3","SUZB3","RENT3","ITSA4","MGLU3","BOVA11","SMAL11","IVVB11"]')
on conflict (chave) do nothing;
