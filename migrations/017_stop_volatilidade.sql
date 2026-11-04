-- Stop pela volatilidade de cada moeda, a pedido do dono: com stop fixo de -1%, a PEPE saiu no stop em
-- 2 minutos, só pela oscilação normal dela. Com `auto_stop_atr`, na hora da compra o piloto mede o ATR
-- (quanto a moeda oscila por vela, no tempo da estratégia) e fixa stop, alvo e proteção daquela
-- operação a partir dele (regrasPelaVolatilidade, em src/risco.ts). Ficam na posição até ela zerar.

alter table estrategias
  add column auto_stop_atr      boolean not null default false,
  add column auto_stop_atr_mult numeric(6,2) not null default 3 check (auto_stop_atr_mult between 0.5 and 20);

-- as regras de saída daquela operação (null = as da estratégia)
alter table posicoes
  add column stop_pct     numeric(8,4),
  add column alvo_pct     numeric(8,4),
  add column protecao_pct numeric(8,4),
  add column recuo_pct    numeric(8,4);

-- liga nas estratégias do piloto da Binance (a posição aberta agora segue com as regras de antes)
update estrategias e set auto_stop_atr = true
  from contas c where c.id = e.conta_id and c.exchange = 'binance' and e.auto_ligado;

-- o contexto do repique tinha os números fixos; agora o stop e o alvo de cada compra vão na ordem
update estrategias
   set ia_contexto = replace(ia_contexto, '(alvo +1,5%, stop -1%)', '(alvo e stop curtos; os desta compra vão na ordem)')
 where ia_contexto like 'Estratégia de REPIQUE%';
