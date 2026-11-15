# pet-desktop

Janela flutuante (Electron) que mostra a interface do hub do `pet-brain`.

```bash
npm install
npm start                       # hub em http://127.0.0.1:8787
PET_HUB_URL=http://100.x.y.z:8787 npm start   # hub em outra máquina (Tailscale)
```

O token é lido de `~/.config/pet-brain/token` (ou `PET_CONFIG_DIR`) pelo processo
principal e só é entregue à página que vem da origem do hub.

## Modo entalho

Por padrão o pet vira uma pílula no topo da tela (rosto + nome). Ao passar o mouse,
focar o campo ou chegar uma aprovação, ela desce num painel com Início, Música e
Aparelhos, e volta sozinha. `PET_NOTCH=0 npm start` usa a janela flutuante antiga.

Ele se identifica ao hub como `pc`; o app do celular como `phone`. Na aba Aparelhos
dá para cutucar o outro pet, e o chat e o humor já são compartilhados pelo hub.
A aba Música controla o player do PC (MPRIS) pelo `playerctl`, no hub.

## Voz

O botão 🎤 do painel grava com o `pw-record`; um segundo toque (ou 30 s) para e o
`whisper-cli` (whisper.cpp) transcreve em português. O texto vai direto ao chat. Tudo
roda no PC e o áudio some logo depois. Ações perigosas continuam pedindo aprovação.

- `PET_WHISPER_MODEL`: modelo ggml (padrão `~/.local/share/whisper.cpp/ggml-base.bin`).
  Um modelo maior (`small`) entende melhor.
- `PET_MIC_SOURCE`: fonte de áudio do PipeWire (padrão: o microfone padrão do sistema).

Testes: `npm test`.

## Hyprland

Janelas sem moldura somem no tiling; deixe-a flutuando e fixa em todos os workspaces.
O próprio pet se posiciona no topo, centralizado, então não use `move`:

```
windowrulev2 = float, class:^(pet-desktop)$
windowrulev2 = pin, class:^(pet-desktop)$
windowrulev2 = noborder, class:^(pet-desktop)$
windowrulev2 = noshadow, class:^(pet-desktop)$
windowrulev2 = noanim, class:^(pet-desktop)$
```
