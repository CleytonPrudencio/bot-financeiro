# Serviço de previsão com o Kronos (modelo de base para velas, licença MIT), só CPU.
# Os pesos são baixados do Hugging Face na montagem da imagem: o container roda numa rede interna,
# sem internet.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HOME=/opt/hf HF_HUB_DISABLE_TELEMETRY=1
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt

ARG KRONOS_MODELO=NeoQuasar/Kronos-small
ARG KRONOS_TOKENIZADOR=NeoQuasar/Kronos-Tokenizer-base
ENV KRONOS_MODELO=${KRONOS_MODELO} KRONOS_TOKENIZADOR=${KRONOS_TOKENIZADOR}
RUN python -c "import os; from huggingface_hub import snapshot_download as d; d(os.environ['KRONOS_MODELO']); d(os.environ['KRONOS_TOKENIZADOR'])"

COPY model ./model
COPY servico.py LICENCA-Kronos.txt ./

RUN useradd --uid 10001 --no-create-home kronos
USER kronos
ENV HF_HUB_OFFLINE=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/saude', timeout=4)"
CMD ["python", "servico.py"]
