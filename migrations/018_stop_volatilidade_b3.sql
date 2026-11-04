-- A pedido do dono: o stop pela volatilidade (ATR) também nas ações da B3 pela ponte MetaTrader 5
-- (Genial). A posição aberta agora segue com as regras de antes; a próxima compra já usa o ATR.

update estrategias e set auto_stop_atr = true
  from contas c where c.id = e.conta_id and c.exchange = 'mt5' and e.auto_ligado;
