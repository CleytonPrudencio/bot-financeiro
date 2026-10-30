"""Ponte Quotex do Bot Financeiro: opções binárias na sua conta da Quotex.

A Quotex não tem API oficial. Esta ponte usa a biblioteca pyquotex (não oficial), roda no seu
computador, com o seu login e a sua internet, e liga para o bot a cada 2 s (só sai conexão: não
precisa abrir porta no roteador). Manda o saldo, os ativos com payout e as velas de 1 min dos
ativos das estratégias, e pega as apostas que o bot já aprovou. A ponte não decide nada; ela só
aposta, e ainda recusa:
  - aposta com mais de 15 s de espera (o sinal ficou velho);
  - aposta acima de PONTE_VALOR_MAX;
  - aposta de outra conta (real com a ponte na demo, ou o contrário).

Configuração (arquivo ponte.env ao lado deste, ou variáveis de ambiente):
  BOT_URL          ex.: https://bot.77.42.120.142.sslip.io
  PONTE_TOKEN      o token que o painel mostrou ao criar a conta Quotex
  QUOTEX_EMAIL     seu login da Quotex (fica só aqui; nunca vai para o bot)
  QUOTEX_SENHA
  PONTE_CONTA      demo (padrão) ou real
  PONTE_VALOR_MAX  teto por aposta (padrão 10)
  QUOTEX_HOST      opcional, se o endereço padrão estiver bloqueado

Uso:  pip install https://github.com/cleitonleonel/pyquotex/archive/refs/heads/master.zip
      python ponte.py
"""

import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSAO = "1.0"
IDADE_MAX_S = 15
INTERVALO_S = 2.0
LISTA_A_CADA_S = 60
VELAS_A_CADA_S = 10
VELAS_ENVIADAS = 150
ESPERA_MAX_S = 295  # a pyquotex desiste de esperar o resultado em 300 s

log = logging.getLogger("ponte")


# ------------------------------------------------------------------ funções puras (testadas)

def conferir_aposta(cmd, valor_max, conta):
    """Motivo para recusar a aposta antes de mandar à Quotex, ou None se pode seguir."""
    if cmd.get("direcao") not in ("call", "put"):
        return "direção desconhecida"
    valor = float(cmd.get("valor") or 0)
    if valor <= 0:
        return "valor da aposta inválido"
    if float(cmd.get("idade_s") or 0) > IDADE_MAX_S:
        return f"aposta esperou {float(cmd.get('idade_s')):.0f} s (máximo {IDADE_MAX_S} s): não feita"
    if valor > valor_max:
        return f"aposta de {valor:.2f} passa do teto da ponte ({valor_max:.2f})"
    if cmd.get("conta") != conta:
        return f"aposta para a conta {cmd.get('conta')}, mas a ponte está na conta {conta} (PONTE_CONTA)"
    return None


def vela_para_lista(v):
    """Uma vela da pyquotex (time em segundos) no formato do bot: [t_ms, abre, max, min, fecha]."""
    alta = v.get("high", v.get("max"))
    baixa = v.get("low", v.get("min"))
    return [int(v["time"]) * 1000, float(v["open"]), float(alta), float(baixa), float(v["close"])]


def ler_instrumentos(instrumentos):
    """A lista crua de ativos da Quotex em {ativo: {...}} (mesmos índices que a pyquotex usa)."""
    saida = {}
    for i in instrumentos or []:
        try:
            ativo = str(i[1])
            saida[ativo] = {
                "ativo": ativo,
                "nome": str(i[2]).replace("\n", "")[:80],
                "aberto": bool(i[14]),
                "payout_1m": _payout(i[-9]),
                "payout_5m": _payout(i[-8]),
            }
        except (IndexError, TypeError, ValueError):
            continue
    return saida


def _payout(valor):
    try:
        p = float(valor)
    except (TypeError, ValueError):
        return None
    return p if 0 <= p <= 100 else None


def resultado_da_quotex(win, esperou_s):
    """O que a pyquotex devolveu (check_win) em ganhou/perdeu, ou None se não dá para saber: ela
    devolve "loss" também quando cansa de esperar (300 s), e aí o bot não pode contar como perda.
    Empate (devolveu o valor) vem como "loss": conta como perda, o que deixa os limites mais apertados."""
    if win == "win":
        return "ganhou"
    if esperou_s < ESPERA_MAX_S:
        return "perdeu"
    return None


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


# ------------------------------------------------------------------ bot

def sincronizar(url, token, corpo):
    pedido = urllib.request.Request(
        url.rstrip("/") + "/ponte/quotex",
        data=json.dumps(corpo).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(pedido, timeout=20) as r:
        return json.loads(r.read())


# ------------------------------------------------------------------ Quotex

async def esperar_resultado(cliente, cmd, id_quotex, fechadas):
    """Espera a Quotex fechar a aposta (como nos exemplos da pyquotex). Sem resultado, não inventa:
    o bot marca a aposta como "confira na Quotex" depois de um tempo."""
    inicio = time.monotonic()
    try:
        win, lucro = await cliente.check_win(id_quotex, int(cmd["prazo_s"]))
    except Exception as e:  # noqa: BLE001
        log.error("aposta %s (%s): erro ao esperar o resultado (%s); confira na Quotex", cmd["id"], id_quotex, e)
        return
    resultado = resultado_da_quotex(win, time.monotonic() - inicio)
    if resultado is None:
        log.error("aposta %s (%s): a Quotex não mandou o resultado; confira na Quotex", cmd["id"], id_quotex)
        return
    log.info("aposta %s (%s): %s (%s)", cmd["id"], id_quotex, resultado.upper(), lucro)
    fechadas.append({"id": cmd["id"], "resultado": resultado, "retorno": float(lucro or 0)})


async def apostar(cliente, cmd):
    """Faz a aposta na Quotex. Devolve o id da Quotex ou levanta erro."""
    ok, info = await cliente.buy(float(cmd["valor"]), cmd["ativo"], cmd["direcao"], int(cmd["prazo_s"]))
    if not ok:
        raise RuntimeError(f"a Quotex recusou: {info}"[:300])
    id_quotex = info.get("id") if isinstance(info, dict) else None
    if not id_quotex:
        raise RuntimeError("a Quotex não devolveu o número da aposta: confira na Quotex")
    return str(id_quotex)


async def principal():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    env = {**ler_env(Path(__file__).with_name("ponte.env")), **os.environ}
    url, token = env.get("BOT_URL"), env.get("PONTE_TOKEN")
    email, senha = env.get("QUOTEX_EMAIL"), env.get("QUOTEX_SENHA")
    if not url or not token:
        raise SystemExit("defina BOT_URL e PONTE_TOKEN (no ponte.env ao lado deste arquivo)")
    if not email or not senha:
        raise SystemExit("defina QUOTEX_EMAIL e QUOTEX_SENHA no ponte.env")
    conta = (env.get("PONTE_CONTA") or "demo").strip().lower()
    if conta not in ("demo", "real"):
        raise SystemExit("PONTE_CONTA tem de ser demo ou real")
    valor_max = float(env.get("PONTE_VALOR_MAX") or "10")

    from pyquotex.stable_api import Quotex  # só no computador do dono

    extra = {"host": env["QUOTEX_HOST"]} if env.get("QUOTEX_HOST") else {}
    cliente = Quotex(email=email, password=senha, lang="pt", **extra)
    ok, motivo = await cliente.connect()
    if not ok:
        raise SystemExit(f"não entrou na Quotex: {motivo}")
    await cliente.change_account("REAL" if conta == "real" else "PRACTICE")
    log.info("Quotex conectada, conta %s (teto por aposta: %.2f)", conta.upper(), valor_max)
    if conta == "real":
        log.warning("CONTA REAL: as apostas aprovadas pelo bot usam dinheiro de verdade")

    observar, ativos = [], {}
    abertas, fechadas, tarefas = [], [], set()
    ultima_lista = ultimas_velas = 0.0
    log.info("ponte ligada ao bot em %s", url)
    while True:
        try:
            agora = time.time()
            mercado = {}
            if agora - ultima_lista > LISTA_A_CADA_S:
                ativos = ler_instrumentos(await cliente.get_instruments())
                mercado = dict(ativos)
                ultima_lista = agora
            if observar and agora - ultimas_velas > VELAS_A_CADA_S:
                for ativo in observar:
                    velas = await cliente.get_candles(ativo, time.time(), VELAS_ENVIADAS * 60, 60) or []
                    item = dict(mercado.get(ativo) or ativos.get(ativo) or {"ativo": ativo, "aberto": False})
                    item["velas"] = [vela_para_lista(v) for v in velas if isinstance(v, dict) and "time" in v][-VELAS_ENVIADAS:]
                    mercado[ativo] = item
                ultimas_velas = agora
            saldo = await cliente.get_balance()
            enviadas_abertas, enviadas_fechadas = list(abertas), list(fechadas)
            corpo = {
                "versao": VERSAO,
                "conta": {"conta": conta, "saldo": max(0.0, float(saldo))},
                "mercado": list(mercado.values()),
                "abertas": enviadas_abertas,
                "fechadas": enviadas_fechadas,
            }
            resposta = await asyncio.to_thread(sincronizar, url, token, corpo)
            # só tira da fila o que o bot recebeu (as tarefas podem ter posto mais enquanto isso)
            del abertas[: len(enviadas_abertas)]
            del fechadas[: len(enviadas_fechadas)]
            novos = [a for a in resposta.get("observar", []) if a not in observar]
            observar = resposta.get("observar", [])
            if novos:
                ultimas_velas = 0.0  # ativo novo: manda as velas já na próxima volta
            for cmd in resposta.get("comandos", []):
                motivo = conferir_aposta(cmd, valor_max, conta)
                if motivo:
                    log.warning("aposta %s recusada pela ponte: %s", cmd.get("id"), motivo)
                    abertas.append({"id": cmd["id"], "ok": False, "erro": motivo})
                    continue
                try:
                    id_quotex = await apostar(cliente, cmd)
                except Exception as e:  # noqa: BLE001 - qualquer recusa volta para o bot como erro
                    log.error("aposta %s falhou: %s", cmd.get("id"), e)
                    abertas.append({"id": cmd["id"], "ok": False, "erro": str(e)[:300]})
                    continue
                log.info("aposta %s: %s %.2f em %s por %s s (Quotex %s)", cmd["id"], cmd["direcao"].upper(), float(cmd["valor"]), cmd["ativo"], cmd["prazo_s"], id_quotex)
                abertas.append({"id": cmd["id"], "ok": True, "id_quotex": id_quotex})
                tarefa = asyncio.create_task(esperar_resultado(cliente, cmd, id_quotex, fechadas))
                tarefas.add(tarefa)
                tarefa.add_done_callback(tarefas.discard)
            if abertas:
                continue  # devolve a confirmação na hora
        except urllib.error.HTTPError as e:
            log.error("o bot respondeu %s: %s", e.code, e.read()[:200])
            if e.code == 401:
                raise SystemExit("token da ponte inválido: gere outro no painel (Binárias)")
            await asyncio.sleep(10)
        except Exception as e:  # noqa: BLE001 - sem internet, bot ou Quotex fora: tenta de novo
            log.error("falha na sincronização: %s", e)
            await asyncio.sleep(5)
        await asyncio.sleep(INTERVALO_S)


if __name__ == "__main__":
    asyncio.run(principal())
