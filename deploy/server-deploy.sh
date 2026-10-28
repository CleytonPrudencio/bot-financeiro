#!/usr/bin/env bash
# Script de deploy do lado do SERVIDOR (vive em /opt/bot-financeiro-deploy/deploy.sh, dono root, 755).
# Chamado pelo hook post-receive do repo bare (/home/botdeploy/bot-financeiro.git) via sudo, quando o
# usuário restrito `botdeploy` recebe um `git push deploy main`.
#
# Só mexe em /opt/bot-financeiro e nos containers do projeto bot-financeiro. Cópia versionada do que
# roda na VM: mudou aqui, rode o setup-vm.sh de novo para levar para lá.
set -euo pipefail

BRANCH="${1:-}"
case "$BRANCH" in
  main) SRC=/opt/bot-financeiro ;;
  *) echo "branch nao deployavel: $BRANCH"; exit 0 ;;
esac

GITDIR=/home/botdeploy/bot-financeiro.git
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# extrai a árvore do branch sem depender do índice do repo bare
git --git-dir="$GITDIR" archive "$BRANCH" | tar -x -C "$TMP"

install -d -m 700 "$SRC"
# o .env só existe no servidor: guarda a senha do banco e as chaves de sessão e de cifra
rsync -a --delete --exclude=.env "$TMP"/ "$SRC"/

cd "$SRC"
if [ ! -f .env ]; then
  umask 077
  {
    echo "BOT_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "BOT_SESSION_SECRET=$(openssl rand -hex 32)"
    echo "BOT_ENCRYPTION_KEY=$(openssl rand -hex 32)"
    echo "BOT_LIVE_ENABLED=false"
    echo "BOT_PUBLIC_URL=https://bot.77.42.120.142.sslip.io"
  } > .env
  echo "criado $SRC/.env com segredos novos: guarde uma cópia do BOT_ENCRYPTION_KEY fora da VM"
fi

docker compose --env-file .env up -d --build
# limpa só as imagens soltas deste projeto; a VM é compartilhada
docker image prune -f --filter label=com.docker.compose.project=bot-financeiro >/dev/null 2>&1 || true
echo "deploy de $BRANCH -> bot-financeiro OK"
