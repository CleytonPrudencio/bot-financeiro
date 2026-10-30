"""Testes das funções puras da ponte Quotex (rodam sem a pyquotex e sem a Quotex).

    python3 -m unittest tests/ponte_quotex_test.py
"""

import importlib.util
import pathlib
import tempfile
import unittest

_ARQ = pathlib.Path(__file__).resolve().parent.parent / "public" / "ponte-quotex" / "ponte.py"
_spec = importlib.util.spec_from_file_location("ponte_quotex", _ARQ)
ponte = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ponte)


class TestePonteQuotex(unittest.TestCase):
    def test_conferir_aposta(self):
        ok = {"id": 1, "direcao": "call", "valor": 5, "idade_s": 1.5, "conta": "demo"}
        self.assertIsNone(ponte.conferir_aposta(ok, 10, "demo"))
        self.assertIn("direção", ponte.conferir_aposta({**ok, "direcao": "x"}, 10, "demo"))
        self.assertIn("inválido", ponte.conferir_aposta({**ok, "valor": 0}, 10, "demo"))
        self.assertIn("esperou", ponte.conferir_aposta({**ok, "idade_s": 16}, 10, "demo"))
        self.assertIn("teto", ponte.conferir_aposta({**ok, "valor": 10.01}, 10, "demo"))
        # aposta real com a ponte na demo (ou o contrário) nunca sai
        self.assertIn("PONTE_CONTA", ponte.conferir_aposta({**ok, "conta": "real"}, 10, "demo"))
        self.assertIn("PONTE_CONTA", ponte.conferir_aposta(ok, 10, "real"))

    def test_vela(self):
        self.assertEqual(ponte.vela_para_lista({"time": 1700000000, "open": 1, "close": 1.5, "high": 2, "low": 0.5}), [1700000000000, 1.0, 2.0, 0.5, 1.5])
        self.assertEqual(ponte.vela_para_lista({"time": 1700000060, "open": 1, "close": 1.5, "max": 2, "min": 0.5}), [1700000060000, 1.0, 2.0, 0.5, 1.5])

    def test_instrumentos(self):
        linha = [0] * 30
        linha[1], linha[2], linha[14] = "EURUSD_otc", "EUR/USD\n(OTC)", True
        linha[-9], linha[-8] = 88, "91"
        ruim = [1, 2]
        r = ponte.ler_instrumentos([linha, ruim, None])
        self.assertEqual(r, {"EURUSD_otc": {"ativo": "EURUSD_otc", "nome": "EUR/USD(OTC)", "aberto": True, "payout_1m": 88.0, "payout_5m": 91.0}})
        linha[-9] = "x"
        self.assertIsNone(ponte.ler_instrumentos([linha])["EURUSD_otc"]["payout_1m"])
        self.assertEqual(ponte.ler_instrumentos(None), {})

    def test_resultado(self):
        self.assertEqual(ponte.resultado_da_quotex("win", 299), "ganhou")
        self.assertEqual(ponte.resultado_da_quotex("loss", 60), "perdeu")
        # a pyquotex devolve "loss" também quando cansa de esperar: aí não dá para saber
        self.assertIsNone(ponte.resultado_da_quotex("loss", 300))

    def test_env(self):
        with tempfile.TemporaryDirectory() as d:
            arq = pathlib.Path(d) / "ponte.env"
            arq.write_text('# comentário\nBOT_URL=https://bot\nQUOTEX_SENHA="a=b"\n\nPONTE_CONTA=demo\n', encoding="utf-8")
            self.assertEqual(ponte.ler_env(arq), {"BOT_URL": "https://bot", "QUOTEX_SENHA": "a=b", "PONTE_CONTA": "demo"})
            self.assertEqual(ponte.ler_env(pathlib.Path(d) / "nao-existe"), {})


if __name__ == "__main__":
    unittest.main()
