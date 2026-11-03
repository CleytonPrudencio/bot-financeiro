-- O agente vetava quase todas as compras: a instrução padrão dizia "só aprove com sinais claros a
-- favor; na dúvida, vete", e com as etapas neutras (o mais comum) ele vetava. A pedido do dono, o
-- agente fica menos rigoroso: aprova quando nada importante é contra e continua vetando quando a
-- técnica ou o risco são contra. A IA segue só podendo barrar; stop e alvo não mudam. Só troca o
-- texto de quem ainda usa o padrão (quem editou o contexto fica como está).

update estrategias
   set ia_contexto = 'Capital pequeno: o stop de perda e o alvo já limitam cada operação. Aprove a compra quando nenhuma etapa importante (técnica ou risco) for claramente contra, mesmo que as outras fiquem neutras. Vete quando a técnica ou o risco forem contra, houver notícia grave ou queda descontrolada. Etapa que falhou não conta nem contra nem a favor.'
 where ia_contexto = 'Capital pequeno (R$ 50) e a prioridade é não perder dinheiro: só aprove a compra com sinais claros a favor; na dúvida, vete.';
