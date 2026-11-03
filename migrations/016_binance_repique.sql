-- A pedido do dono: todas as estratégias do piloto nas contas da Binance passam para o estilo repique
-- (compra a moeda que caiu demais quando ela começa a voltar). Com o mercado em queda, a tendência
-- quase nunca dava entrada.
--   - o estilo muda em todas; o tempo das velas e a varredura ficam como estavam;
--   - stop, alvo e proteção vão para os do repique (-1% / +1,5% / 0,8% com recuo de 0,4%), menos em
--     quem está com posição aberta: mudar a saída no meio da operação poderia vender na hora;
--   - o contexto da IA passa para o do repique só onde era um dos textos padrão (quem escreveu o
--     seu fica como está).

with alvo as (
  select e.id
    from estrategias e join contas c on c.id = e.conta_id
   where c.exchange = 'binance' and e.auto_ligado and e.auto_estilo = 'tendencia'
)
update estrategias e
   set auto_estilo = 'repique',
       ia_contexto = case
         when e.ia_contexto is null
           or e.ia_contexto like 'Capital pequeno (R$ 50) e a prioridade é não perder dinheiro%'
           or e.ia_contexto like 'Capital pequeno: o stop de perda e o alvo já limitam cada operação%'
         then 'Estratégia de REPIQUE: compra a moeda que caiu demais (IFR abaixo de 30) quando a vela volta a fechar em alta, para um ganho curto (alvo +1,5%, stop -1%). A tendência de baixa no dia é esperada nesta estratégia e não é motivo para vetar sozinha. Vete se houver notícia grave, queda descontrolada ou risco claro de continuar caindo forte.'
         else e.ia_contexto
       end,
       auto_stop_pct = case when coalesce(p.quantidade, 0) > 0 then e.auto_stop_pct else 1 end,
       auto_alvo_pct = case when coalesce(p.quantidade, 0) > 0 then e.auto_alvo_pct else 1.5 end,
       auto_protecao_pct = case when coalesce(p.quantidade, 0) > 0 then e.auto_protecao_pct else 0.8 end,
       auto_recuo_pct = case when coalesce(p.quantidade, 0) > 0 then e.auto_recuo_pct else 0.4 end
  from alvo left join posicoes p on p.estrategia_id = alvo.id
 where e.id = alvo.id;
