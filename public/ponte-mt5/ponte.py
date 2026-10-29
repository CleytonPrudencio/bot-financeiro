"""Ponte MetaTrader 5 do Bot Financeiro: ações da B3 pela sua corretora (ex.: XP).

Roda no Windows, ao lado do MetaTrader 5 aberto e logado na corretora. A cada 1 s ela liga para o
bot (só sai conexão: não precisa abrir porta no roteador), manda cotações, velas e o saldo, e pega
as ordens que o bot já aprovou (regras de risco, agente de IA e as três chaves do dinheiro real).
A ponte não decide nada; ela só executa, e ainda recusa:
  - ordem com mais de 20 s de espera (ex.: o PC estava desligado);
  - ordem acima de PONTE_VALOR_MAX reais (padrão R$ 200).

Configuração (variáveis de ambiente, ou o arquivo ponte.env ao lado deste):
  BOT_URL         ex.: https://bot.77.42.120.142.sslip.io
  PONTE_TOKEN     o token que o painel mostrou ao criar a conta MetaTrader 5
  PONTE_VALOR_MAX teto por ordem em reais (padrão 200)

Uso:  pip install MetaTrader5   e depois   python ponte.py
"""

import json
import logging
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSAO = "1.0"
MAGIC = 50501  # marca as ordens do bot no MetaTrader
LOTE_PADRAO = 100  # na B3, lote padrão de ações; abaixo disso, mercado fracionário (código + "F")
IDADE_MAX_S = 20
INTERVALO_S = 1.0
VELAS_A_CADA_S = 60
QTD_VELAS = {"5m": 300, "15m": 300, "1h": 300, "4h": 300, "1d": 130}

log = logging.getLogger("ponte")


# ------------------------------------------------------------------ funções puras (testadas)

def dividir_lote(quantidade, lote=LOTE_PADRAO):
    """Separa a quantidade em lote padrão (múltiplo de 100) e fracionário (o resto)."""
    quantidade = int(quantidade)
    if quantidade < 1:
        return 0, 0
    padrao = (quantidade // lote) * lote
    return padrao, quantidade - padrao


def preco_medio(execucoes):
    """execucoes: [(quantidade, preco)] -> (quantidade total, preço médio ponderado)."""
    total = sum(q for q, _ in execucoes)
    if total <= 0:
        return 0, 0.0
    return total, sum(q * p for q, p in execucoes) / total


def conferir_ordem(cmd, valor_max):
    """Motivo para recusar a ordem antes de mandar à corretora, ou None se pode seguir."""
    if cmd.get("lado") not in ("compra", "venda"):
        return "lado desconhecido"
    if int(cmd.get("quantidade") or 0) < 1:
        return "quantidade menor que 1 ação"
    if float(cmd.get("idade_s") or 0) > IDADE_MAX_S:
        return f"ordem esperou {cmd.get('idade_s'):.0f} s (máximo {IDADE_MAX_S} s): não executada"
    valor = int(cmd["quantidade"]) * float(cmd.get("preco_ref") or 0)
    if cmd["lado"] == "compra" and valor > valor_max:
        return f"ordem de R$ {valor:.2f} passa do teto da ponte (R$ {valor_max:.2f})"
    return None


def vela_para_lista(v):
    """Uma vela do MT5 (time em segundos) no formato do bot: [t_ms, abre, max, min, fecha, volume]."""
    return [int(v["time"]) * 1000, float(v["open"]), float(v["high"]), float(v["low"]), float(v["close"]), float(v["real_volume"] or v["tick_volume"])]


def ler_env(arquivo):
    """Lê um arquivo CHAVE=valor (linhas com # são comentário)."""
    valores = {}
    if arquivo.exists():
        for linha in arquivo.read_text(encoding="utf-8").splitlines():
            linha = linha.strip()
            if linha and not linha.startswith("#") and "=" in linha:
                chave, valor = linha.split("=", 1)
                valores[chave.strip()] = valor.strip().strip('"')
    return valores


# ------------------------------------------------------------------ MetaTrader 5

class MetaTrader:
    def __init__(self):
        import MetaTrader5 as mt5  # só existe no Windows

        self.mt5 = mt5
        if not mt5.initialize():
            raise SystemExit(f"não conectou no MetaTrader 5 (ele está aberto e logado?): {mt5.last_error()}")
        info = mt5.account_info()
        if info is None:
            raise SystemExit("o MetaTrader 5 abriu, mas sem conta logada")
        if not mt5.terminal_info().trade_allowed:
            log.warning("o botão 'Algo Trading' do MetaTrader está desligado: as ordens vão ser recusadas")
        self.tempos = {"5m": mt5.TIMEFRAME_M5, "15m": mt5.TIMEFRAME_M15, "1h": mt5.TIMEFRAME_H1, "4h": mt5.TIMEFRAME_H4, "1d": mt5.TIMEFRAME_D1}
        log.info("MetaTrader conectado: %s, servidor %s", info.company, info.server)

    def conta(self):
        info = self.mt5.account_info()
        posicoes = {}
        for p in self.mt5.positions_get() or []:
            codigo = p.symbol[:-1] if p.symbol.endswith("F") else p.symbol
            posicoes[codigo] = posicoes.get(codigo, 0) + (p.volume if p.type == self.mt5.POSITION_TYPE_BUY else -p.volume)
        return {
            "corretora": info.company,
            "servidor": info.server,
            "moeda": info.currency,
            "saldo": float(info.equity),
            "saldo_livre": float(info.margin_free),
            "posicoes": posicoes,
        }

    def mercado(self, simbolos, tempos, com_velas):
        saida = []
        for s in simbolos:
            if not self.mt5.symbol_select(s, True):
                continue
            tick = self.mt5.symbol_info_tick(s)
            info = self.mt5.symbol_info(s)
            item = {
                "simbolo": s,
                "cotacao": float(tick.last or tick.bid) if tick and (tick.last or tick.bid) else None,
                "volume_financeiro": float(getattr(info, "session_turnover", 0) or 0) if info else None,
            }
            if com_velas:
                item["velas"] = {}
                for t in tempos:
                    barras = self.mt5.copy_rates_from_pos(s, self.tempos[t], 0, QTD_VELAS[t])
                    if barras is not None and len(barras):
                        item["velas"][t] = [vela_para_lista(b) for b in barras]
            saida.append(item)
        return saida

    def _enviar(self, simbolo, lado, quantidade):
        mt5 = self.mt5
        if not mt5.symbol_select(simbolo, True):
            raise RuntimeError(f"a corretora não tem {simbolo}")
        tick = mt5.symbol_info_tick(simbolo)
        info = mt5.symbol_info(simbolo)
        compra = lado == "compra"
        modo = info.filling_mode
        preenchimento = mt5.ORDER_FILLING_IOC if modo & 2 else mt5.ORDER_FILLING_FOK if modo & 1 else mt5.ORDER_FILLING_RETURN
        pedido = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": simbolo,
            "volume": float(quantidade),
            "type": mt5.ORDER_TYPE_BUY if compra else mt5.ORDER_TYPE_SELL,
            "price": float(tick.ask if compra else tick.bid),
            "deviation": 20,
            "magic": MAGIC,
            "comment": "bot-financeiro",
            "type_time": mt5.ORDER_TIME_DAY,
            "type_filling": preenchimento,
        }
        r = mt5.order_send(pedido)
        if r is None:
            raise RuntimeError(f"o MetaTrader não respondeu: {mt5.last_error()}")
        if r.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_DONE_PARTIAL):
            raise RuntimeError(f"corretora recusou ({r.retcode}): {r.comment}")
        return float(r.volume), float(r.price or pedido["price"]), str(r.order)

    def executar(self, cmd):
        padrao, fracionario = dividir_lote(cmd["quantidade"])
        execucoes, ids = [], []
        for simbolo, qtd in ((cmd["simbolo"], padrao), (cmd["simbolo"] + "F", fracionario)):
            if qtd <= 0:
                continue
            q, p, ordem = self._enviar(simbolo, cmd["lado"], qtd)
            execucoes.append((q, p))
            ids.append(ordem)
        quantidade, preco = preco_medio(execucoes)
        if quantidade <= 0:
            raise RuntimeError("nenhuma parte da ordem foi executada")
        return {"preco": preco, "quantidade": quantidade, "id_exchange": ",".join(ids)}


# ------------------------------------------------------------------ laço

def sincronizar(url, token, corpo):
    pedido = urllib.request.Request(
        url.rstrip("/") + "/ponte/sincronizar",
        data=json.dumps(corpo).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(pedido, timeout=20) as r:
        return json.loads(r.read())


def principal():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    env = {**ler_env(Path(__file__).with_name("ponte.env")), **os.environ}
    url, token = env.get("BOT_URL"), env.get("PONTE_TOKEN")
    if not url or not token:
        raise SystemExit("defina BOT_URL e PONTE_TOKEN (no ponte.env ao lado deste arquivo)")
    valor_max = float(env.get("PONTE_VALOR_MAX", "200"))
    mt = MetaTrader()
    observar, tempos = [], ["15m", "1d"]
    resultados, ultimas_velas = [], 0.0
    log.info("ponte ligada ao bot em %s (teto por ordem: R$ %.2f)", url, valor_max)
    while True:
        try:
            com_velas = time.time() - ultimas_velas > VELAS_A_CADA_S
            corpo = {"versao": VERSAO, "conta": mt.conta(), "mercado": mt.mercado(observar, tempos, com_velas), "resultados": resultados}
            resposta = sincronizar(url, token, corpo)
            resultados = []
            if com_velas and observar:
                ultimas_velas = time.time()
            observar, tempos = resposta.get("observar", []), resposta.get("tempos", tempos)
            for cmd in resposta.get("comandos", []):
                motivo = conferir_ordem(cmd, valor_max)
                if motivo:
                    log.warning("ordem %s recusada pela ponte: %s", cmd.get("id"), motivo)
                    resultados.append({"id": cmd["id"], "ok": False, "erro": motivo})
                    continue
                try:
                    r = mt.executar(cmd)
                    log.info("ordem %s: %s %s %s a %.2f", cmd["id"], cmd["lado"], r["quantidade"], cmd["simbolo"], r["preco"])
                    resultados.append({"id": cmd["id"], "ok": True, **r})
                except Exception as e:  # noqa: BLE001 - qualquer recusa volta para o bot como erro
                    log.error("ordem %s falhou: %s", cmd.get("id"), e)
                    resultados.append({"id": cmd["id"], "ok": False, "erro": str(e)[:300]})
            if resultados:
                continue  # devolve o resultado na hora
        except urllib.error.HTTPError as e:
            log.error("o bot respondeu %s: %s", e.code, e.read()[:200])
            if e.code == 401:
                raise SystemExit("token da ponte inválido: gere outro no painel (Contas)")
            time.sleep(10)
        except Exception as e:  # noqa: BLE001 - sem internet, bot fora do ar: tenta de novo
            log.error("falha na sincronização: %s", e)
            time.sleep(5)
        time.sleep(INTERVALO_S)


if __name__ == "__main__":
    principal()
