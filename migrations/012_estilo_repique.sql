-- Estilo do piloto: "tendencia" (compra a favor da alta, como até aqui) ou "repique" (compra a moeda
-- que caiu demais quando ela começa a voltar, com alvo e stop curtos).
alter table estrategias add column auto_estilo text not null default 'tendencia' check (auto_estilo in ('tendencia', 'repique'));

-- As estratégias "uma por moeda" (Piloto BTC, Piloto ETH...) passam a repique: com o mercado em queda,
-- é o estilo que tem chance de comprar. A estratégia padrão (varredura) segue em tendência.
update estrategias
   set auto_estilo = 'repique', auto_stop_pct = 1, auto_alvo_pct = 1.5, auto_protecao_pct = 0.8, auto_recuo_pct = 0.4,
       ia_contexto = 'Estratégia de REPIQUE: compra a moeda que caiu demais (IFR abaixo de 30) quando a vela volta a fechar em alta, para um ganho curto (alvo +1,5%, stop -1%). A tendência de baixa no dia é esperada nesta estratégia e não é motivo para vetar sozinha. Vete se houver notícia grave, queda descontrolada ou risco claro de continuar caindo forte.'
 where auto_ligado and not auto_varrer and auto_tempo = '1m' and nome like 'Piloto %'
   and id <> coalesce((select (valor->>'id')::bigint from configuracoes where chave = 'estrategia_padrao'), 0);
