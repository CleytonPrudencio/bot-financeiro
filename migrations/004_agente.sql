-- Agente em etapas: uma esteira em que cada etapa (pesquisa, sentimento, técnica, risco) usa a IA
-- escolhida para ela, e uma última IA lê tudo e dá o veredito. Como o conselho, só pode BARRAR.
-- A configuração das etapas fica em configuracoes (chave 'agente').

insert into configuracoes (chave, valor) values ('agente', '{"etapas": {}}') on conflict do nothing;

-- Como a estratégia usa as IAs: 'conselho' (todas votam ao mesmo tempo) ou 'agente' (a esteira decide)
alter table estrategias
  add column ia_tipo text not null default 'conselho' check (ia_tipo in ('conselho', 'agente'));

-- Cada passada pela esteira: de um sinal de verdade ou de um teste no painel.
create table agente_execucoes (
  id            bigserial primary key,
  sinal_id      bigint references sinais(id) on delete cascade,
  estrategia_id bigint references estrategias(id) on delete cascade,
  origem        text not null check (origem in ('sinal', 'teste')),
  simbolo       text not null,
  lado          text not null check (lado in ('compra', 'venda')),
  situacao      text not null default 'rodando' check (situacao in ('rodando', 'pronta', 'falhou')),
  etapas        jsonb not null default '{}',   -- {pesquisa: {situacao, conector, resultado|erro, ms}, ...}
  decisao       text check (decisao in ('aprovar', 'vetar')),
  confianca     numeric(4,3),
  motivo        text,
  ms            integer,
  criada_em     timestamptz not null default now()
);
create index agente_execucoes_criada_em_ix on agente_execucoes (criada_em desc);
create index agente_execucoes_sinal_ix on agente_execucoes (sinal_id);
