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

    def test_planejar_fechamento(self):
        # conta hedge: fecha pelo número da posição; lote padrão só em múltiplo de 100
        posicoes = [(11, "PETR4", 200), (12, "PETR4F", 30), (13, "PETR4F", 10)]
        self.assertEqual(ponte.planejar_fechamento(posicoes, 240), [(11, "PETR4", 200), (12, "PETR4F", 30), (13, "PETR4F", 10)])
        self.assertEqual(ponte.planejar_fechamento(posicoes, 135), [(11, "PETR4", 100), (12, "PETR4F", 30), (13, "PETR4F", 5)])
        # mais do que existe: vende o que tem
        self.assertEqual(ponte.planejar_fechamento([(12, "PETR4F", 30)], 50), [(12, "PETR4F", 30)])
        # 57 ações só no lote padrão não fecham (seria venda parcial fora do lote)
        self.assertEqual(ponte.planejar_fechamento([(11, "PETR4", 100)], 57), [])
        self.assertEqual(ponte.planejar_fechamento([], 10), [])

    def test_escolher_velas(self):
        simbolos = ["PETR4", "VALE3", "ITUB4"]
        # nunca mandou: as mais antigas primeiro, até o limite
        self.assertEqual(ponte.escolher_velas(simbolos, {}, 1000, por_vez=2), {"PETR4", "VALE3"})
        # mandou há pouco: espera; a que está vencida há mais tempo vai antes
        envio = {"PETR4": 990, "VALE3": 900, "ITUB4": 800}
        self.assertEqual(ponte.escolher_velas(simbolos, envio, 1000, por_vez=1, a_cada=60), {"ITUB4"})
        self.assertEqual(ponte.escolher_velas(simbolos, envio, 1000, por_vez=5, a_cada=60), {"VALE3", "ITUB4"})

    def test_conferir_ordem(self):
        ok = {"lado": "compra", "quantidade": 1, "preco_ref": 38.0, "idade_s": 1.2}
        self.assertIsNone(ponte.conferir_ordem(ok, 200))
        self.assertIn("esperou", ponte.conferir_ordem({**ok, "idade_s": 25}, 200))
        self.assertIn("teto", ponte.conferir_ordem({**ok, "quantidade": 10}, 200))
        # venda nunca é barrada pelo teto: sair da posição não pode travar
        self.assertIsNone(ponte.conferir_ordem({**ok, "lado": "venda", "quantidade": 10}, 200))
        self.assertIn("lado", ponte.conferir_ordem({**ok, "lado": "x"}, 200))
        self.assertIn("menor que 1", ponte.conferir_ordem({**ok, "quantidade": 0}, 200))

    def test_arquivo_env(self):
        with tempfile.TemporaryDirectory() as d:
            pasta = pathlib.Path(d)
            self.assertEqual(ponte.arquivo_env(pasta).name, "ponte.env")
            (pasta / "ponte.env.txt").write_text("BOT_URL=x", encoding="utf-8")
            self.assertEqual(ponte.arquivo_env(pasta).name, "ponte.env.txt")
            (pasta / "ponte.env").write_text("BOT_URL=y", encoding="utf-8")
            self.assertEqual(ponte.arquivo_env(pasta).name, "ponte.env")
            # Bloco de Notas com BOM: a primeira chave não pode vir com o caractere invisível
            (pasta / "ponte.env").write_text("BOT_URL=y\nPONTE_TOKEN=abc", encoding="utf-8-sig")
            self.assertEqual(ponte.ler_env(pasta / "ponte.env"), {"BOT_URL": "y", "PONTE_TOKEN": "abc"})

    def test_vela_e_env(self):
        v = {"time": 1700000000, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "real_volume": 0, "tick_volume": 7}
        self.assertEqual(ponte.vela_para_lista({**v, "close": 16.479999542236328})[4], 16.48)
        self.assertEqual(ponte.vela_para_lista(v), [1700000000000, 1.0, 2.0, 0.5, 1.5, 7.0])
        with tempfile.TemporaryDirectory() as d:
            arq = pathlib.Path(d) / "ponte.env"
            arq.write_text('# comentário\nBOT_URL=https://x\nPONTE_TOKEN="abc"\n', encoding="utf-8")
            self.assertEqual(ponte.ler_env(arq), {"BOT_URL": "https://x", "PONTE_TOKEN": "abc"})


if __name__ == "__main__":
    unittest.main()
