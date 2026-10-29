-- Piloto olhando o mercado inteiro: em vez de um par fixo, ele varre os pares da moeda da conta
-- (ex.: todos os pares em BRL da Binance com volume) e opera o melhor, um de cada vez. Olha a cada
-- poucos minutos, com velas de 5 min a 1 dia (sempre a última vela FECHADA).

alter table estrategias
  add column auto_varrer      boolean not null default false,
  add column auto_tempo       text not null default '1d' check (auto_tempo in ('5m', '15m', '1h', '4h', '1d')),
  -- de quantos em quantos minutos o piloto olha o mercado
  add column auto_intervalo_min integer not null default 2 check (auto_intervalo_min between 1 and 1440),
  -- volume mínimo de 24 h do par, na moeda de cotação, para entrar na varredura
  add column auto_volume_min  numeric(30,12) not null default 500000 check (auto_volume_min >= 0),
  -- teto de consultas ao agente de IA por dia (custo): passou disso, o piloto espera o dia seguinte
  add column auto_max_ia_dia  integer not null default 6 check (auto_max_ia_dia between 0 and 100),
  add column auto_varrido_em  timestamptz;

-- a estratégia padrão passa a varrer todos os pares em reais, a cada 2 min, com velas de 15 min
update estrategias
   set auto_varrer = true, auto_tempo = '15m', auto_intervalo_min = 2, intervalo_min_seg = 3600,
       nome = 'Piloto Binance em reais (padrão)'
 where id = (select (valor->>'id')::bigint from configuracoes where chave = 'estrategia_padrao');
