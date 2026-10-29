-- Entrada também em tendência já em curso (sem esperar a virada). Com isso desligado, o piloto pode
-- comprar um par que já estava em alta na vela anterior, desde que tudo o mais continue valendo
-- (médias, MACD, IFR entre 40 e 70, tendência diária, Kronos e agente).
alter table estrategias add column auto_exigir_virada boolean not null default true;

update estrategias set auto_exigir_virada = false
 where id = (select (valor->>'id')::bigint from configuracoes where chave = 'estrategia_padrao');
