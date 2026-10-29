-- O que o piloto viu em cada par na última varredura (o escritório ao vivo põe um robô por par):
-- [{ "simbolo", "preco", "variacao_pct", "volume", "motivo", "virou" }]
alter table estrategias add column auto_varredura jsonb;
