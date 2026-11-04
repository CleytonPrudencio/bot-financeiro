-- A pedido do dono: cada estratégia pode consultar a IA até 10 vezes por dia (antes 2 nas "uma por
-- moeda" e 6 na padrão). As novas já nascem com 10.
update estrategias set auto_max_ia_dia = 10;
