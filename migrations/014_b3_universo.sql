-- Mais ações da B3 na ponte MetaTrader 5: a lista que ela acompanha (e de onde "Todas as moedas"
-- tira uma estratégia por ação) passa de 17 para as ~50 mais negociadas, com ETFs. Código que a
-- corretora não tiver é só pulado pela ponte. Junta com o que já estava (o dono pode ter mudado).

update configuracoes
   set valor = (
     select to_jsonb(array_agg(distinct x order by x))
       from (
         select jsonb_array_elements_text(valor) as x
         union
         select unnest(array[
           'PETR4','PETR3','VALE3','ITUB4','BBDC4','BBDC3','BBAS3','ABEV3','WEGE3','B3SA3','PRIO3','ELET3',
           'SUZB3','RENT3','ITSA4','MGLU3','BBSE3','BPAC11','RADL3','EQTL3','LREN3','GGBR4','GOAU4','CSNA3',
           'USIM5','CMIG4','VBBR3','UGPA3','RAIL3','HAPV3','CSAN3','COGN3','TIMS3','VIVT3','SBSP3','KLBN11',
           'TAEE11','ENEV3','CYRE3','MRVE3','ASAI3','ALOS3','MULT3','TOTS3','CXSE3','BRAP4','SANB11','CPFE3',
           'BOVA11','SMAL11','IVVB11'
         ])
       ) todos
   ),
       alterado_em = now()
 where chave = 'mt5_universo';
