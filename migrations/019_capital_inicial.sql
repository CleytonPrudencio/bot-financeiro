-- Quanto o dono colocou em cada conta, para o painel mostrar o saldo subindo e descendo a partir dele
-- ("tinha 50, agora 48, agora 52"). Edita-se no painel. Já sai com o que o dono contou: R$ 50 na
-- Binance e R$ 100 na Genial (MetaTrader), nas contas reais.
alter table contas add column capital_inicial numeric(30,12) check (capital_inicial is null or capital_inicial >= 0);
update contas set capital_inicial = 50 where exchange = 'binance' and modo = 'real' and capital_inicial is null;
update contas set capital_inicial = 100 where exchange = 'mt5' and modo = 'real' and capital_inicial is null;
