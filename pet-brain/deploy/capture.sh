#!/bin/sh
# Captura rápida: pergunta uma ideia (rofi/wofi/fuzzel) e joga no inbox do cofre do pet.
# Atalho no Hyprland:  bind = SUPER, N, exec, ~/lucky/pet-brain/deploy/capture.sh
set -e
ENV_FILE="${HOME}/.config/pet-brain/hub.env"
if [ -r "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
if [ "$#" -gt 0 ]; then
  text="$*"
elif command -v rofi >/dev/null 2>&1; then
  text="$(rofi -dmenu -p 'anota' </dev/null || true)"
elif command -v fuzzel >/dev/null 2>&1; then
  text="$(fuzzel --dmenu --prompt 'anota ' </dev/null || true)"
elif command -v wofi >/dev/null 2>&1; then
  text="$(wofi --dmenu --prompt 'anota' </dev/null || true)"
else
  echo "Instale rofi, fuzzel ou wofi, ou passe o texto: capture.sh minha ideia" >&2
  exit 1
fi
[ -n "$text" ] || exit 0
exec node "$(dirname "$0")/../dist/index.js" capture "$text"
