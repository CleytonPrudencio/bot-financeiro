#!/usr/bin/env bash
# Publica o Bot Financeiro na VM Hetzner do começo ao fim. Roda no SEU computador (Git Bash), na
# raiz deste repositório, com a chave de root da VM em ~/.ssh/saplink_hetzner:
#
#   bash scripts/publicar-na-vm.sh voce@exemplo.com
#
# O e-mail vira o primeiro usuário do painel (só na primeira vez). Pode rodar de novo quantas vezes
# quiser: cada etapa confere se já foi feita e pula. Etapas:
#
#   1. chaves de deploy (~/.ssh/bot_ci e ~/.ssh/bot_deploy)
#   2. prepara a VM (usuário botdeploy, repo bare, hook, sudo) — deploy/setup-vm.sh
#   3. primeiro deploy (git push direto para a VM)
#   4. guarda uma cópia do BOT_ENCRYPTION_KEY fora da VM (~/.ssh/bot-financeiro.encryption-key)
#   5. bloco no Caddy compartilhado: backup, acrescenta, valida (desfaz se reprovar), recarrega
#   6. espera https://bot.77.42.120.142.sslip.io/saude responder
#   7. cria o usuário do painel, se ainda não houver nenhum
#   8. segredos do GitHub Actions (com o GitHub CLI, se instalado) para os próximos deploys
set -euo pipefail

VM=77.42.120.142
CHAVE_ROOT="$HOME/.ssh/saplink_hetzner"
CHAVE_CI="$HOME/.ssh/bot_ci"
CHAVE_DEPLOY="$HOME/.ssh/bot_deploy"
COPIA_CIFRA="$HOME/.ssh/bot-financeiro.encryption-key"
DOMINIO=bot.77.42.120.142.sslip.io
REPO_GH=CleytonPrudencio/bot-financeiro
CADDYFILE=/opt/saplink/deploy/Caddyfile
EMAIL="${1:-}"
case "$EMAIL" in
  '' | *@*.*) ;;
  *) echo "e-mail inválido: $EMAIL" >&2; exit 1 ;;
esac
case "$EMAIL" in *[\'\"\ \;\$\`]*) echo "e-mail com caractere inválido" >&2; exit 1 ;; esac

passo() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '   \033[32mok\033[0m %s\n' "$*"; }
aviso() { printf '   \033[33m!!\033[0m %s\n' "$*"; }
falha() { printf '\n\033[31mPAROU:\033[0m %s\n' "$*" >&2; exit 1; }
root() { ssh -i "$CHAVE_ROOT" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "root@$VM" "$@"; }

# ------------------------------------------------------------------ conferências
passo "0. Conferências"
[ -f deploy/setup-vm.sh ] && [ -f docker-compose.yml ] || falha "rode na raiz do repositório bot-financeiro (cd /c/git/bot-financeiro)"
[ -f "$CHAVE_ROOT" ] || falha "não achei a chave de root da VM em $CHAVE_ROOT"
command -v ssh-keygen >/dev/null || falha "ssh-keygen não encontrado (rode no Git Bash)"
root true || falha "não consegui entrar na VM como root com $CHAVE_ROOT"
ok "acesso root à VM"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || falha "o seu clone não está igual à origin/main. Rode: git checkout main && git pull"
ok "clone igual à origin/main ($(git rev-parse --short HEAD))"

# ------------------------------------------------------------------ 1. chaves
passo "1. Chaves de deploy"
if [ -f "$CHAVE_CI" ] || [ -f "$CHAVE_CI.pub" ]; then
  ok "já existe $CHAVE_CI"
else
  ssh-keygen -q -t ed25519 -C "bot-ci-github-actions" -f "$CHAVE_CI" -N ""
  ok "criada $CHAVE_CI (só do GitHub Actions)"
fi
if [ -f "$CHAVE_DEPLOY" ]; then
  ok "já existe $CHAVE_DEPLOY"
else
  ssh-keygen -q -t ed25519 -C "bot-deploy" -f "$CHAVE_DEPLOY" -N ""
  ok "criada $CHAVE_DEPLOY (deploy manual; sem senha para o script rodar sozinho)"
fi
PUBS=("$CHAVE_DEPLOY.pub")
[ -f "$CHAVE_CI.pub" ] && PUBS+=("$CHAVE_CI.pub")

# ------------------------------------------------------------------ 2. VM
passo "2. Preparar a VM (botdeploy, repo bare, hook, sudo)"
nomes=()
for p in "${PUBS[@]}"; do nomes+=("/tmp/bot-setup/$(basename "$p")"); done
tar czf - deploy -C "$HOME/.ssh" "${PUBS[@]##*/}" \
  | root "rm -rf /tmp/bot-setup && mkdir /tmp/bot-setup && tar xzf - -C /tmp/bot-setup && bash /tmp/bot-setup/deploy/setup-vm.sh ${nomes[*]}; s=\$?; rm -rf /tmp/bot-setup; exit \$s" \
  | sed 's/^/   /'
ok "VM preparada"

# ------------------------------------------------------------------ 3. deploy
passo "3. Deploy (git push para a VM)"
log="$(mktemp)"
GIT_SSH_COMMAND="ssh -i $CHAVE_DEPLOY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
  git push --force "botdeploy@$VM:bot-financeiro.git" "HEAD:refs/heads/main" 2>&1 | tee "$log" | sed 's/^/   /' || true
if grep -q "deploy falhou" "$log"; then
  falha "a VM recebeu o push, mas o deploy falhou (veja acima). Logs: ssh -i $CHAVE_ROOT root@$VM 'docker logs --tail 100 bot-app'"
fi
if grep -Eq "deploy de main -> bot-financeiro OK" "$log"; then
  ok "containers no ar"
elif grep -q "Everything up-to-date" "$log"; then
  ok "a VM já estava nesta versão"
  root "cd /opt/bot-financeiro && docker compose --env-file .env up -d" >/dev/null 2>&1 || true
else
  falha "a VM não confirmou o deploy (veja a saída acima)"
fi
rm -f "$log"

# ------------------------------------------------------------------ 4. cópia da chave de cifra
passo "4. Cópia do BOT_ENCRYPTION_KEY fora da VM"
valor="$(root "grep '^BOT_ENCRYPTION_KEY=' /opt/bot-financeiro/.env | cut -d= -f2-")"
[ -n "$valor" ] || falha "não achei BOT_ENCRYPTION_KEY em /opt/bot-financeiro/.env"
if [ -f "$COPIA_CIFRA" ] && [ "$(cat "$COPIA_CIFRA")" != "$valor" ]; then
  aviso "a cópia em $COPIA_CIFRA é diferente da VM; guardando a da VM ao lado (.novo)"
  (umask 077; printf '%s\n' "$valor" > "$COPIA_CIFRA.novo")
else
  (umask 077; printf '%s\n' "$valor" > "$COPIA_CIFRA")
  ok "guardada em $COPIA_CIFRA (guarde também no gerenciador de senhas)"
fi
unset valor

# ------------------------------------------------------------------ 5. Caddy
passo "5. Caddy compartilhado"
if root "grep -q '^$DOMINIO' $CADDYFILE"; then
  ok "o bloco de $DOMINIO já está no Caddyfile"
else
  # backup, acrescenta (cat >>, nunca sed -i: o arquivo é bind de arquivo único), valida e só então recarrega;
  # se a validação reprovar, devolve o conteúdo do backup no MESMO arquivo e para
  root "set -e
    bak=$CADDYFILE.bak-\$(date +%F-%H%M%S)-bot
    cp $CADDYFILE \$bak
    cat >> $CADDYFILE
    if docker exec saplink-caddy caddy validate --config /etc/caddy/Caddyfile >/tmp/caddy-validate.log 2>&1; then
      docker exec saplink-caddy caddy reload --config /etc/caddy/Caddyfile
      echo 'Caddy recarregado'
    else
      cat \$bak > $CADDYFILE
      echo 'VALIDACAO REPROVOU: Caddyfile restaurado do backup' >&2
      tail -5 /tmp/caddy-validate.log >&2
      exit 1
    fi" < deploy/Caddyfile.bot | sed 's/^/   /' \
    || falha "o Caddy reprovou o bloco novo; nada mudou nos outros sites (o arquivo foi restaurado)"
  ok "bloco de $DOMINIO acrescentado e Caddy recarregado"
fi

# ------------------------------------------------------------------ 6. saúde
passo "6. https://$DOMINIO/saude"
saude=""
for _ in $(seq 1 24); do
  saude="$(curl -fsS -m 10 "https://$DOMINIO/saude" 2>/dev/null || true)"
  case "$saude" in *'"ok":true'*) break ;; esac
  sleep 5
done
case "$saude" in
  *'"ok":true'*) ok "respondendo: $saude" ;;
  *) falha "https://$DOMINIO/saude não respondeu em 2 minutos. Veja: ssh -i $CHAVE_ROOT root@$VM 'docker logs --tail 50 saplink-caddy; docker logs --tail 50 bot-app'" ;;
esac

# ------------------------------------------------------------------ 7. usuário do painel
passo "7. Usuário do painel"
usuarios="$(root "docker exec bot-db psql -U bot bot -Atc 'select count(*) from usuarios'")"
if [ "${usuarios:-0}" != "0" ]; then
  ok "já existe usuário no painel (para trocar a senha: docker exec bot-app node dist/scripts/criar-admin.js <email>)"
elif [ -z "$EMAIL" ]; then
  aviso "nenhum usuário ainda. Rode de novo com o seu e-mail: bash scripts/publicar-na-vm.sh voce@exemplo.com"
else
  printf '\n'
  root "docker exec bot-app node dist/scripts/criar-admin.js '$EMAIL'" | sed 's/^/   /'
  aviso "a senha acima aparece só agora: guarde no gerenciador de senhas"
fi

# ------------------------------------------------------------------ 8. GitHub Actions
passo "8. Segredos do GitHub Actions (deploy automático a cada push)"
if [ ! -f "$CHAVE_CI" ]; then
  ok "a chave do CI já foi cadastrada e apagada daqui antes"
elif command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh secret set BOT_DEPLOY_KEY --repo "$REPO_GH" < "$CHAVE_CI"
  ssh-keyscan "$VM" 2>/dev/null | gh secret set BOT_KNOWN_HOSTS --repo "$REPO_GH"
  rm -f "$CHAVE_CI"
  ok "BOT_DEPLOY_KEY e BOT_KNOWN_HOSTS cadastrados; a chave privada do CI foi apagada deste computador"
else
  aviso "GitHub CLI não instalado ou sem login: o deploy funciona, mas os próximos pushes não publicam sozinhos."
  aviso "Para resolver, instale e entre uma vez, depois rode este script de novo:"
  printf '       winget install --id GitHub.cli\n       gh auth login\n'
fi

passo "Pronto"
echo "   Painel: https://$DOMINIO  (começa em SIMULAÇÃO; dinheiro real exige as três chaves do README)"
