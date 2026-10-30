-- Velas de 1 minuto no piloto (o dono pediu para operar no curtíssimo prazo).
alter table estrategias drop constraint estrategias_auto_tempo_check;
alter table estrategias add constraint estrategias_auto_tempo_check check (auto_tempo in ('1m', '5m', '15m', '1h', '4h', '1d'));

-- a estratégia padrão da Binance passa a ler velas de 1 min, olhando a cada 1 min; o stop e o alvo
-- encolhem para a escala do minuto (3% num gráfico de 1 min é uma eternidade)
update estrategias
   set auto_tempo = '1m', auto_intervalo_min = 1,
       auto_stop_pct = 1.5, auto_alvo_pct = 3, auto_protecao_pct = 1.2, auto_recuo_pct = 0.6
 where id = (select (valor->>'id')::bigint from configuracoes where chave = 'estrategia_padrao');
