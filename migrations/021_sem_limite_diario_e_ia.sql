-- A pedido do dono: sem teto para a soma das compras do dia e sem teto de consultas à IA.
-- O teto diário travava a recompra: o dinheiro volta na venda e gira de novo, mas a soma do dia já
-- tinha chegado ao limite. Continuam valendo o valor e o limite por ordem, o limite da posição, uma
-- posição por vez e o saldo da conta. null = sem limite (dá para pôr de volta no painel).
alter table estrategias alter column limite_diario drop not null;
alter table estrategias alter column auto_max_ia_dia drop not null;
alter table estrategias alter column auto_max_ia_dia drop default;
update estrategias set limite_diario = null, auto_max_ia_dia = null;
