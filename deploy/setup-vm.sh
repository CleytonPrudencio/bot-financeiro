#!/usr/bin/env bash
# Preparação da VM para o deploy do Bot Financeiro. Roda uma vez, como root, a partir de um clone
# deste repositório na VM:
#
#   sudo bash deploy/setup-vm.sh /caminho/bot_ci.pub [/caminho/bot_deploy.pub ...]
#
# Cria o usuário restrito `botdeploy` (só git-shell), o repo bare que recebe o push, o hook, o script
# de deploy em /opt/bot-financeiro-deploy e a única regra de sudo desse usuário.
# Pode rodar de novo: o que já existe é mantido e as chaves só são acrescentadas.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "rode como root (sudo)"; exit 1; }
[ "$#" -ge 1 ] || { echo "uso: $0 chave.pub [outra.pub ...]"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
USER_NAME=botdeploy
HOME_DIR=/home/$USER_NAME
GITDIR=$HOME_DIR/bot-financeiro.git
GIT_SHELL="$(command -v git-shell)"

docker network inspect saplink_default >/dev/null \
  || { echo "rede saplink_default (Caddy) não encontrada"; exit 1; }
[ ! -e /opt/bot-financeiro ] || [ -d /opt/bot-financeiro ] \
  || { echo "/opt/bot-financeiro existe e não é pasta"; exit 1; }

grep -qx "$GIT_SHELL" /etc/shells || echo "$GIT_SHELL" >> /etc/shells
id "$USER_NAME" >/dev/null 2>&1 \
  || useradd --create-home --home-dir "$HOME_DIR" --shell "$GIT_SHELL" "$USER_NAME"
passwd -l "$USER_NAME" >/dev/null

# chaves: só podem fazer git push, sem túnel nem terminal
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
AUTH="$HOME_DIR/.ssh/authorized_keys"
touch "$AUTH"
for pub in "$@"; do
  key="$(cat "$pub")"
  grep -qF "$key" "$AUTH" || echo "restrict $key" >> "$AUTH"
done
chown "$USER_NAME:$USER_NAME" "$AUTH"
chmod 600 "$AUTH"

[ -d "$GITDIR" ] || sudo -u "$USER_NAME" git init -q --bare "$GITDIR"
install -m 755 -o "$USER_NAME" -g "$USER_NAME" "$HERE/post-receive" "$GITDIR/hooks/post-receive"

install -d -m 755 /opt/bot-financeiro-deploy
install -m 755 -o root -g root "$HERE/server-deploy.sh" /opt/bot-financeiro-deploy/deploy.sh

SUDOERS=/etc/sudoers.d/botdeploy
echo "$USER_NAME ALL=(root) NOPASSWD: /opt/bot-financeiro-deploy/deploy.sh" > "$SUDOERS.tmp"
visudo -cf "$SUDOERS.tmp" >/dev/null
chmod 440 "$SUDOERS.tmp"
mv "$SUDOERS.tmp" "$SUDOERS"

echo "pronto: $USER_NAME@$(hostname):bot-financeiro.git recebe o push da main"
echo "falta: acrescentar deploy/Caddyfile.bot ao Caddy (ver DEPLOY.md)"
