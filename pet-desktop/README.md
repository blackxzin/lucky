# pet-desktop

Janela flutuante (Electron) que mostra a interface do hub do `pet-brain`.

```bash
npm install
npm start                       # hub em http://127.0.0.1:8787
PET_HUB_URL=http://100.x.y.z:8787 npm start   # hub em outra máquina (Tailscale)
```

O token é lido de `~/.config/pet-brain/token` (ou `PET_CONFIG_DIR`) pelo processo
principal e só é entregue à página que vem da origem do hub.

## Hyprland

Janelas sem moldura somem no tiling; deixe-a flutuando e fixa em todos os workspaces:

```
windowrulev2 = float, class:^(pet-desktop)$
windowrulev2 = pin, class:^(pet-desktop)$
windowrulev2 = move 100%-360 100%-540, class:^(pet-desktop)$
```
