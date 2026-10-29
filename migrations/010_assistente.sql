-- Assistente XP: ações da B3 sem API de corretora. O bot analisa e decide, e no dinheiro real
-- (as três chaves) não manda ordem: manda um AVISO (Telegram e painel) para o dono executar na XP.
-- A ordem só entra no histórico quando o dono confirma o que fez, com o preço de verdade.
-- Cotação e velas vêm do gráfico público do Yahoo Finance (PETR4.SA), sem chave.

-- conta "b3" (assistida): não tem chave nem token, porque o bot nunca fala com a corretora
alter table contas drop constraint contas_check;
alter table contas add constraint contas_check check (
  modo = 'simulacao'
  or exchange = 'b3'
  or (exchange = 'mt5' and ponte_token_hash is not null)
  or (api_key_cifrada is not null and api_secret_cifrada is not null)
);

-- sinal que virou aviso para o dono (ainda não é ordem)
alter table sinais drop constraint sinais_situacao_check;
alter table sinais add constraint sinais_situacao_check check (situacao in ('executado', 'rejeitado', 'ignorado', 'erro', 'alerta'));

-- ordem que o dono executou na corretora e confirmou no bot
alter table ordens add column manual boolean not null default false;

-- último stop que o assistente mandou o dono registrar na corretora
alter table posicoes add column stop_avisado numeric(30,12);

create table alertas (
  id              bigserial primary key,
  estrategia_id   bigint not null references estrategias(id) on delete cascade,
  sinal_id        bigint references sinais(id) on delete set null,
  lado            text not null check (lado in ('compra', 'venda')),
  simbolo         text not null,
  quantidade      numeric(30,12) not null check (quantidade > 0),
  preco_ref       numeric(30,12) not null,
  stop            numeric(30,12),
  alvo            numeric(30,12),
  motivo          text,
  situacao        text not null default 'pendente' check (situacao in ('pendente', 'confirmado', 'recusado', 'expirado')),
  preco_executado numeric(30,12),
  quantidade_executada numeric(30,12),
  telegram_msg_id bigint,
  pergunta_msg_id bigint,                    -- mensagem "qual preço?" do Telegram, para casar a resposta
  criado_em       timestamptz not null default now(),
  expira_em       timestamptz,               -- só compra expira (o preço anda); aviso de venda fica até a resposta
  respondido_em   timestamptz
);
create index alertas_pendentes_ix on alertas (estrategia_id) where situacao = 'pendente';

-- ações que o assistente acompanha (as mais negociadas e ETFs)
insert into configuracoes (chave, valor) values ('b3_universo', '["PETR4","VALE3","ITUB4","BBDC4","BBAS3","ABEV3","WEGE3","B3SA3","PRIO3","ELET3","SUZB3","RENT3","ITSA4","MGLU3","BOVA11","SMAL11","IVVB11"]')
on conflict (chave) do nothing;
