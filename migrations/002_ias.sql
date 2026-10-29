-- Conectores de IA: cada um é um modelo (Claude, ChatGPT, Gemini, Ollama...) que dá parecer sobre
-- a ordem antes de ela sair. A IA só pode BARRAR uma ordem que as regras de risco já aprovaram;
-- nunca cria ordem nem passa por cima de limite.

create table conectores_ia (
  id               bigserial primary key,
  nome             text not null,
  -- anthropic: SDK oficial da Anthropic · openai: qualquer API compatível com a da OpenAI
  provedor         text not null check (provedor in ('anthropic', 'openai')),
  url_base         text,                          -- só openai: https://api.openai.com/v1 etc.
  modelo           text not null,
  api_key_cifrada  text,                          -- mesma cifra das chaves das exchanges; Ollama local não usa
  esforco          text not null default 'low' check (esforco in ('low', 'medium', 'high')),
  timeout_seg      integer not null default 25 check (timeout_seg between 3 and 120),
  instrucoes       text,                          -- "personalidade" extra do conector (opcional)
  ativo            boolean not null default true,
  ultimo_teste     jsonb,                         -- {ok, ms, em, erro?} do último teste no painel
  criado_em        timestamptz not null default now()
);

-- Como cada estratégia usa as IAs.
--   desligado   : não consulta
--   consultivo  : consulta e grava o parecer, mas não barra nada
--   obrigatorio : a ordem só sai com pelo menos ia_quorum aprovações (null = todas as consultadas)
alter table estrategias
  add column ia_modo          text not null default 'desligado' check (ia_modo in ('desligado', 'consultivo', 'obrigatorio')),
  add column ia_conectores    bigint[] not null default '{}',   -- vazio = todos os conectores ativos
  add column ia_quorum        integer check (ia_quorum is null or ia_quorum >= 1),
  -- IA que não respondeu (erro, tempo, recusa): "reprova" conta como não aprovou; "ignora" tira da conta
  add column ia_falha         text not null default 'reprova' check (ia_falha in ('reprova', 'ignora')),
  add column ia_confianca_min numeric(4,3) not null default 0.6 check (ia_confianca_min between 0 and 1),
  -- por padrão só compras passam pela IA: barrar uma venda pode prender uma posição perdendo
  add column ia_nas_vendas    boolean not null default false,
  add column ia_contexto      text;                             -- o que a estratégia faz, para a IA entender o sinal

-- Parecer de cada IA consultada num sinal.
create table pareceres_ia (
  id            bigserial primary key,
  sinal_id      bigint references sinais(id) on delete cascade,
  estrategia_id bigint references estrategias(id) on delete cascade,
  conector_id   bigint references conectores_ia(id) on delete set null,
  conector_nome text not null,
  modelo        text not null,
  decisao       text check (decisao in ('aprovar', 'vetar')),   -- null quando falhou
  confianca     numeric(4,3),
  motivo        text,
  erro          text,
  ms            integer not null,
  criado_em     timestamptz not null default now()
);
create index pareceres_ia_sinal_ix on pareceres_ia (sinal_id);
