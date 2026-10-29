"""Testes do que não depende do modelo (rodam sem torch): python -m unittest test_servico"""
import unittest

import servico


class Resumo(unittest.TestCase):
    def test_mediana_faixa_e_chance_de_alta(self):
        caminhos = [[101, 102], [99, 98], [100, 110], [100, 104]]
        r = servico.resumir(caminhos, 100.0)
        self.assertEqual(r["mediana"], [100.0, 103.0])
        self.assertEqual(r["prob_alta"], 0.75)
        self.assertAlmostEqual(r["retorno_mediano_pct"], 3.0)
        self.assertLess(r["retorno_p10_pct"], 0)
        self.assertGreater(r["retorno_p90_pct"], 5)


class Validacao(unittest.TestCase):
    def vela(self, i, preco=100.0):
        return {"t": 1_700_000_000_000 + i * 86_400_000, "abre": preco, "max": preco, "min": preco, "fecha": preco, "volume": 1}

    def test_poucas_velas(self):
        with self.assertRaises(ValueError):
            servico.prever({"velas": [self.vela(i) for i in range(10)]})

    def test_horizonte_e_caminhos_fora_da_faixa(self):
        velas = [self.vela(i) for i in range(40)]
        with self.assertRaises(ValueError):
            servico.prever({"velas": velas, "horizonte": 0})
        with self.assertRaises(ValueError):
            servico.prever({"velas": velas, "caminhos": 100})

    def test_preco_invalido(self):
        velas = [self.vela(i) for i in range(40)]
        velas[5]["fecha"] = 0
        with self.assertRaises(ValueError):
            servico.prever({"velas": velas})


if __name__ == "__main__":
    unittest.main()
