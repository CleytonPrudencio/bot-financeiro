"""Serviço HTTP de previsão com o Kronos, para o Bot Financeiro.

Recebe as velas diárias de um ativo e devolve vários caminhos possíveis para os próximos dias
(amostras independentes do modelo): a mediana, a faixa de 10% a 90% e a chance de terminar acima
do preço de hoje. Não decide nada: é um dado a mais para os agentes de IA do bot.

  GET  /saude   -> {"ok": true, "modelo": ...}
  POST /prever  -> {"velas": [{"t": ms, "abre", "max", "min", "fecha", "volume"}...], "horizonte": 5, "caminhos": 16}

Só escuta na rede interna do bot (sem porta no host). Uma previsão por vez.
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODELO = os.environ.get("KRONOS_MODELO", "NeoQuasar/Kronos-small")
TOKENIZADOR = os.environ.get("KRONOS_TOKENIZADOR", "NeoQuasar/Kronos-Tokenizer-base")
CONTEXTO = 400            # o Kronos-small aceita até 512 velas
MAX_HORIZONTE = 30
MAX_CAMINHOS = 32
MAX_CORPO = 512 * 1024

_previsor = None
_trava = threading.Lock()


def carregar():
    """Carrega o modelo uma vez (os pesos já estão na imagem)."""
    global _previsor
    if _previsor is None:
        import torch
        from model import Kronos, KronosPredictor, KronosTokenizer

        torch.set_num_threads(int(os.environ.get("KRONOS_THREADS", "2")))
        tokenizador = KronosTokenizer.from_pretrained(TOKENIZADOR)
        modelo = Kronos.from_pretrained(MODELO)
        _previsor = KronosPredictor(modelo, tokenizador, device="cpu", max_context=512)
    return _previsor


def resumir(caminhos, ultimo):
    """caminhos: matriz (N caminhos x H dias) de fechamentos previstos; ultimo: fechamento de hoje."""
    c = np.asarray(caminhos, dtype=float)
    final = c[:, -1]
    pct = lambda x: float((x / ultimo - 1) * 100)
    return {
        "mediana": [float(v) for v in np.median(c, axis=0)],
        "p10": [float(v) for v in np.percentile(c, 10, axis=0)],
        "p90": [float(v) for v in np.percentile(c, 90, axis=0)],
        "retorno_mediano_pct": round(pct(np.median(final)), 3),
        "retorno_p10_pct": round(pct(np.percentile(final, 10)), 3),
        "retorno_p90_pct": round(pct(np.percentile(final, 90)), 3),
        "prob_alta": round(float(np.mean(final > ultimo)), 3),
    }


def prever(corpo):
    import pandas as pd

    velas = corpo.get("velas")
    if not isinstance(velas, list) or len(velas) < 30:
        raise ValueError("mande pelo menos 30 velas")
    horizonte = int(corpo.get("horizonte", 5))
    caminhos = int(corpo.get("caminhos", 16))
    if not 1 <= horizonte <= MAX_HORIZONTE:
        raise ValueError(f"horizonte de 1 a {MAX_HORIZONTE}")
    if not 1 <= caminhos <= MAX_CAMINHOS:
        raise ValueError(f"caminhos de 1 a {MAX_CAMINHOS}")

    velas = velas[-CONTEXTO:]
    df = pd.DataFrame(
        {
            "open": [float(v["abre"]) for v in velas],
            "high": [float(v["max"]) for v in velas],
            "low": [float(v["min"]) for v in velas],
            "close": [float(v["fecha"]) for v in velas],
            "volume": [float(v.get("volume") or 0) for v in velas],
        }
    )
    if not np.isfinite(df.values).all() or (df[["open", "high", "low", "close"]] <= 0).any().any():
        raise ValueError("velas com valor inválido")
    tempos = pd.Series(pd.to_datetime([int(v["t"]) for v in velas], unit="ms"))
    passo = tempos.diff().median()
    futuros = pd.Series([tempos.iloc[-1] + passo * (i + 1) for i in range(horizonte)])

    previsor = carregar()
    inicio = time.time()
    with _trava:
        # N cópias da mesma série = N caminhos independentes (sample_count=1 em cada)
        resultado = previsor.predict_batch(
            [df] * caminhos, [tempos] * caminhos, [futuros] * caminhos,
            pred_len=horizonte, T=1.0, top_p=0.9, sample_count=1, verbose=False,
        )
    matriz = [r["close"].to_numpy() for r in resultado]
    ultimo = float(df["close"].iloc[-1])
    return {
        "modelo": MODELO,
        "horizonte": horizonte,
        "caminhos": caminhos,
        "ultimo": ultimo,
        "datas": [d.strftime("%Y-%m-%d") for d in futuros],
        **resumir(matriz, ultimo),
        "ms": int((time.time() - inicio) * 1000),
    }


class Tratador(BaseHTTPRequestHandler):
    def _responder(self, status, dados):
        bruto = json.dumps(dados).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(bruto)))
        self.end_headers()
        self.wfile.write(bruto)

    def do_GET(self):
        if self.path == "/saude":
            return self._responder(200, {"ok": True, "modelo": MODELO, "carregado": _previsor is not None})
        self._responder(404, {"erro": "não encontrado"})

    def do_POST(self):
        if self.path != "/prever":
            return self._responder(404, {"erro": "não encontrado"})
        tamanho = int(self.headers.get("content-length") or 0)
        if tamanho <= 0 or tamanho > MAX_CORPO:
            return self._responder(413, {"erro": "corpo vazio ou grande demais"})
        try:
            corpo = json.loads(self.rfile.read(tamanho))
            self._responder(200, prever(corpo))
        except (ValueError, KeyError, TypeError) as e:
            self._responder(400, {"erro": str(e)[:200]})
        except Exception as e:  # noqa: BLE001 - qualquer falha do modelo vira 500 com mensagem curta
            self._responder(500, {"erro": f"falha na previsão: {type(e).__name__}"})

    def log_message(self, formato, *args):
        print(f"{self.address_string()} {formato % args}", flush=True)


if __name__ == "__main__":
    carregar()  # carrega na subida: a primeira previsão não paga o tempo de carga
    print(f"kronos pronto: {MODELO}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8000), Tratador).serve_forever()
