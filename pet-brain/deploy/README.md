# Hub como serviço (systemd, usuário)

O hub sobe sozinho no login e reinicia se cair. Nada aqui usa sudo.

1. Coloque o projeto em `~/pet-brain` (ou ajuste o `ExecStart` da unit) e rode `npm ci && npm run build` nele.
2. Para escutar no Tailscale, crie `~/.config/pet-brain/hub.env` (modo 600):

   ```
   PET_HUB_HOST=100.x.y.z
   ```

   Sem esse arquivo, o hub escuta só em 127.0.0.1.
3. Instale e ligue:

   ```bash
   mkdir -p ~/.config/systemd/user && cp deploy/pet-hub.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now pet-hub
   ```

4. Para continuar rodando sem sessão aberta: `loginctl enable-linger $USER`.
5. Logs: `journalctl --user -u pet-hub -f`.

O token do hub fica em `~/.config/pet-brain/token`.
