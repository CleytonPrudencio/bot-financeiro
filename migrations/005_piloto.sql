-- Piloto automático: o próprio bot gera os sinais da estratégia (sem TradingView).
-- Entrada só quando a tendência vira a favor numa vela diária fechada (e passa pelo risco e pelo
-- agente); saída por stop de perda, alvo de ganho, proteção do ganho ou quebra da tendência.

alter table estrategias
  add column auto_ligado     boolean not null default false,
  add column auto_stop_pct   numeric(8,4) not null default 3   check (auto_stop_pct > 0 and auto_stop_pct <= 50),
  add column auto_alvo_pct   numeric(8,4) not null default 6   check (auto_alvo_pct > 0 and auto_alvo_pct <= 200),
  -- ganho a partir do qual o stop sobe para proteger o lucro
  add column auto_protecao_pct numeric(8,4) not null default 2.5 check (auto_protecao_pct > 0 and auto_protecao_pct <= 100),
  -- recuo desde o maior preço que fecha a posição depois que a proteção ligou
  add column auto_recuo_pct  numeric(8,4) not null default 1.5 check (auto_recuo_pct > 0 and auto_recuo_pct <= 50),
  -- abertura (ms) da última vela diária que o piloto já avaliou: uma entrada por vela, no máximo
  add column auto_ultima_vela bigint,
  add column auto_situacao   text,
  add column auto_checado_em timestamptz;

-- maior preço visto desde a compra (para a proteção do ganho)
alter table posicoes add column maior_preco numeric(30,12);
