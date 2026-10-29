"""Testes das funções puras da ponte MT5 (rodam no Linux: não importam o MetaTrader5).

    python3 -m unittest tests/ponte_mt5_test.py
"""

import importlib.util
import pathlib
import tempfile
import unittest

_ARQ = pathlib.Path(__file__).resolve().parent.parent / "public" / "ponte-mt5" / "ponte.py"
_spec = importlib.util.spec_from_file_location("ponte", _ARQ)
ponte = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ponte)


class TestePonte(unittest.TestCase):
    def test_dividir_lote(self):
        self.assertEqual(ponte.dividir_lote(1), (0, 1))
        self.assertEqual(ponte.dividir_lote(99), (0, 99))
        self.assertEqual(ponte.dividir_lote(100), (100, 0))
        self.assertEqual(ponte.dividir_lote(257), (200, 57))
        self.assertEqual(ponte.dividir_lote(0), (0, 0))

    def test_preco_medio(self):
        self.assertEqual(ponte.preco_medio([(100, 10.0), (50, 13.0)]), (150, 11.0))
        self.assertEqual(ponte.preco_medio([]), (0, 0.0))

    def test_conferir_ordem(self):
        ok = {"lado": "compra", "quantidade": 1, "preco_ref": 38.0, "idade_s": 1.2}
        self.assertIsNone(ponte.conferir_ordem(ok, 200))
        self.assertIn("esperou", ponte.conferir_ordem({**ok, "idade_s": 25}, 200))
        self.assertIn("teto", ponte.conferir_ordem({**ok, "quantidade": 10}, 200))
        # venda nunca é barrada pelo teto: sair da posição não pode travar
        self.assertIsNone(ponte.conferir_ordem({**ok, "lado": "venda", "quantidade": 10}, 200))
        self.assertIn("lado", ponte.conferir_ordem({**ok, "lado": "x"}, 200))
        self.assertIn("menor que 1", ponte.conferir_ordem({**ok, "quantidade": 0}, 200))

    def test_vela_e_env(self):
        v = {"time": 1700000000, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "real_volume": 0, "tick_volume": 7}
        self.assertEqual(ponte.vela_para_lista(v), [1700000000000, 1.0, 2.0, 0.5, 1.5, 7.0])
        with tempfile.TemporaryDirectory() as d:
            arq = pathlib.Path(d) / "ponte.env"
            arq.write_text('# comentário\nBOT_URL=https://x\nPONTE_TOKEN="abc"\n', encoding="utf-8")
            self.assertEqual(ponte.ler_env(arq), {"BOT_URL": "https://x", "PONTE_TOKEN": "abc"})


if __name__ == "__main__":
    unittest.main()
