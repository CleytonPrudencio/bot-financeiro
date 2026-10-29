-- Análise completa com 5 agentes de IA (técnico, fundamental, sentimento, risco e tese), no
-- modelo do projeto ai-trading-claude. Cada análise guarda o resultado de cada agente e a nota
-- final (0 a 100). A estratégia pode exigir nota mínima recente para COMPRAR.

create table analises (
  id            bigserial primary key,
  simbolo       text not null,                 -- formato CCXT (BTC/USDT) ou ticker de ação
  exchange      text,                          -- de onde vieram as velas; null = sem dados de mercado
  situacao      text not null default 'rodando' check (situacao in ('rodando', 'pronta', 'falhou')),
  nota          integer check (nota between 0 and 100),
  conceito      text,
  sinal         text,
  agentes       jsonb not null default '{}',   -- {tecnico: {situacao, conector, resultado|erro, ms}, ...}
  dados         jsonb,                         -- indicadores calculados que os agentes receberam
  pesquisa_web  boolean not null default false,
  usuario_id    bigint references usuarios(id) on delete set null,
  criada_em     timestamptz not null default now(),
  terminada_em  timestamptz
);
create index analises_simbolo_ix on analises (simbolo, terminada_em desc);
create index analises_criada_em_ix on analises (criada_em desc);

alter table estrategias
  add column analise_nota_min   integer check (analise_nota_min is null or analise_nota_min between 0 and 100),
  add column analise_validade_h integer not null default 24 check (analise_validade_h between 1 and 720);
