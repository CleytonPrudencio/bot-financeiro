-- A pedido do dono ("perdendo dinheiro"): o agente volta a ser exigente. Não é a regra antiga de
-- "na dúvida, vete" com tudo neutro (que vetava tudo também porque o agente media o gatilho no gráfico
-- errado, já corrigido): agora precisa de pelo menos uma etapa importante a favor e nenhuma contra, e a
-- confiança mínima da aprovação sobe de 60% para 70%. Quem escreveu o próprio contexto fica como está.

update estrategias set ia_contexto = 'Capital pequeno e a taxa come o ganho de operação ruim: aprove a compra só quando pelo menos uma etapa importante (técnica, risco ou previsão) for a favor e nenhuma delas for contra. Tudo neutro não basta: na dúvida, vete. Vete também com notícia grave ou queda descontrolada. Etapa que falhou não conta a favor.'
 where ia_contexto = 'Capital pequeno: o stop de perda e o alvo já limitam cada operação. Aprove a compra quando nenhuma etapa importante (técnica ou risco) for claramente contra, mesmo que as outras fiquem neutras. Vete quando a técnica ou o risco forem contra, houver notícia grave ou queda descontrolada. Etapa que falhou não conta nem contra nem a favor.';

update estrategias set ia_contexto = ia_contexto || ' Seja exigente: aprove só se o gatilho estiver confirmado nas velas da estratégia e pelo menos uma etapa importante (técnica, risco ou previsão) for a favor, sem nenhuma contra. Na dúvida, vete.'
 where ia_contexto like 'Estratégia de REPIQUE%' and ia_contexto not like '%Seja exigente:%';

update estrategias set ia_confianca_min = 0.7 where ia_modo = 'obrigatorio' and ia_confianca_min < 0.7;
