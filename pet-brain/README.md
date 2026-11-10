# pet-brain

Cérebro do pet: um MCP server que conversa com o Maestri e escreve no cofre Obsidian do pet.

Fase 1 (esqueleto). O pet em si (PC, Android), o controle do PC e o canal remoto vêm nas próximas fases.

## Tools

| Tool | O que faz |
|---|---|
| `maestri_list` | Lista agentes, notas e portais conectados no Maestri |
| `maestri_ask` | Envia um prompt a um agente e espera a resposta (timeout padrão 120s, máximo 600s) |
| `maestri_check` | Lê a tela atual do terminal de um agente |
| `vault_write` | Cria ou substitui uma nota `.md` no cofre, com frontmatter e `[[links]]` |

## Rodar

```bash
npm install
npm run build
npm test
```

## Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `PET_VAULT_DIR` | `~/pet-vault` | Cofre do pet. Caminho absoluto. Use uma pasta só dele, separada do seu cofre principal |
| `MAESTRI_CLI` | `maestri` (PATH) | Caminho do binário do Maestri |

Para ver o cofre no Obsidian: "Abrir pasta como cofre" e escolha `~/pet-vault`.

## Dentro do Maestri

A CLI `maestri` só funciona dentro de um terminal do Maestri. Então:

1. Crie um terminal no canvas e ligue ele aos agentes que o pet deve controlar.
2. Nesse terminal, rode o agente que vai usar o pet-brain (Claude Code, OpenCode) com o server registrado. Exemplo com Claude Code:

```bash
claude mcp add pet-brain -- node /caminho/para/pet-brain/dist/index.js
```

O server herda `MAESTRI_CLI` e o acesso ao canvas desse terminal.

## No Claude Desktop

Em `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pet-brain": {
      "command": "node",
      "args": ["/caminho/para/pet-brain/dist/index.js"],
      "env": { "PET_VAULT_DIR": "/home/voce/pet-vault" }
    }
  }
}
```

Reinicie o Claude Desktop. Fora do Maestri, `vault_write` funciona e as tools `maestri_*` respondem com um erro explicando que a CLI não foi encontrada.

## Segurança nesta fase

- O `maestri` é chamado sem shell (`execFile`), então nada no prompt é interpretado como comando.
- Nomes de agente e prompts que começam com `-` são recusados, para não virarem flags (`--raw`, `--batch`).
- `vault_write` só escreve dentro do cofre: recusa `..`, caminho absoluto, symlink que sai do cofre e pastas ocultas (`.obsidian`).
- Sem `--raw` e sem execução de comandos no PC ainda. Isso entra na Fase 3 junto com allowlist, confirmação e log de auditoria.

## Hub (o pet conversando)

```bash
npm run build
node dist/index.js hub        # http://127.0.0.1:8787, token em ~/.config/pet-brain/token
node dist/index.js pending    # pedidos esperando
node dist/index.js approve <id>   # só em terminal interativo; pede para digitar "sim"
node dist/index.js deny <id>
```

Rode o hub **dentro de um terminal do Maestri** para o pet controlar o Maestri.
Para o celular: `PET_HUB_HOST=<ip do Tailscale> node dist/index.js hub`.
Clientes: `../pet-desktop` (Electron) e `../pet-android` (`./build.sh`).
Decisões e riscos residuais: `docs/decisions.md` (15–24).

## Reserva quando o Claude cai

Se o `claude` falhar (não instalado, deslogado, assinatura vencida), o hub responde pelo OpenCode, só com as ferramentas do `pet-brain` e as mesmas travas. Modelo: `PET_OPENCODE_MODEL` (padrão `opencode/big-pickle`, formato `provider/modelo`). Binário: `OPENCODE_BIN`. O reserva não guarda histórico entre mensagens.

## Lembretes, status e resumo diário

- Peça ao pet "me lembra de X daqui a 20 minutos": ele usa `reminder_add` e o aviso aparece no chat na hora.
- `/status` no chat mostra o estado do hub e as últimas ações (sem o texto delas).
- Todo dia o hub escreve `journal/AAAA-MM-DD-resumo.md` com contagens do dia anterior.
- No celular, o pet avisa por notificação quando chega pedido de aprovação (até 15s de atraso).
- Hub no boot: veja `deploy/README.md`.

## Celular (Android)

- Instalar: `cd pet-android && ./build.sh && adb install -r build/pet.apk`.
- Por cabo: `adb reverse tcp:8787 tcp:8787`, URL `http://127.0.0.1:8787`, token de `~/.config/pet-brain/token`. Pela rede: Tailscale e `http://100.x.y.z:8787`.
- Tocar na bolinha abre o chat; o botão **—** fecha só o chat. O pet volta sozinho depois do boot e depois de atualizar o app.
- Microfone: só com a tela de voz do Google visível; o app não tem permissão de microfone (decisão 33).
- Notificação de aprovação: consulta a cada 15s. Pedido aprovado ou negado em menos de 15s não notifica.
