# Decisões

## Fase 1

1. **Cofre do pet separado do cofre principal.** O pet escreve só em `PET_VAULT_DIR` (padrão `~/pet-vault`), uma pasta própria. Ele nunca toca no cofre Obsidian pessoal. Pedido do dono do projeto.
2. **`maestri` chamado com `execFile`, sem shell.** Evita injeção de comando pelo texto do prompt.
3. **Agente ou prompt começando com `-` é recusado.** A CLI poderia ler como flag. Não usamos `--` porque não foi confirmado que a CLI aceita.
4. **`maestri_send_raw` e `maestri_notify` ficaram fora.** `--raw` digita direto em terminais, então só entra junto com allowlist e confirmação (Fase 3).
5. **`vault_write` substitui a nota inteira.** Preserva `created`, atualiza `updated`. Edição parcial fica para a Fase 2.
6. **Pastas ocultas são bloqueadas no cofre.** Protege `.obsidian` (config e plugins) de escrita pelo modelo.
7. **Erros de tool voltam como `isError`.** Uma falha do Maestri não derruba o server.
8. **Timeout do `ask`: 120s padrão, 600s máximo.** No timeout, a mensagem manda usar `maestri_check` em vez de reenviar.
9. **Timeout mata com SIGKILL.** Um processo que ignora SIGTERM não pode segurar o server.
10. **Mensagem de erro do maestri nunca usa `error.message`.** O Node coloca os argumentos (o prompt inteiro) nela. Usamos stderr, depois stdout, depois o código de saída, cortado em 2000 caracteres.
11. **Erro inesperado vira "Erro interno" para o modelo.** O detalhe (que pode ter caminhos da máquina) vai só para o stderr do server.
12. **`created` é lido só do frontmatter.** Parser por linhas, lê no máximo 64KB e 200 linhas, aceita CRLF, ignora valor que não é data. Substitui a regex antiga, que era lenta e pegava `created:` no corpo.
13. **Symlink no lugar da nota é recusado**, e symlink visível apontando para pasta oculta do cofre também.
14. **Corrida entre checagem e escrita (TOCTOU) é aceita.** Assume-se que só o pet-brain e o Obsidian do dono mexem no cofre. Se outro processo não confiável ganhar acesso de escrita ao cofre, isso precisa ser revisto.

## Fases 2–6 (hub, UI, desktop, Android)

15. **Quem pensa pelo pet é o `claude -p`, ligado só ao MCP `pet-brain`.** Flags: `--tools ""` (sem Bash/Edit nativos), `--strict-mcp-config`, `--allowedTools mcp__pet-brain`, `--setting-sources ""`. Prompt vai por stdin, nunca em argumento. Testado ao vivo.
16. **O modelo nunca aprova a si mesmo.** Ferramentas perigosas devolvem "NÃO EXECUTADO" + id. Aprovação vale para aquela ferramenta e ação exatas, uma vez, 10 min.
17. **Aprovar = humano.** Pela UI (WebSocket autenticado) ou por `pet-brain approve <id>`, que exige TTY e digitar "sim". Negar não exige TTY. Limite conhecido: um agente rodando num terminal do Maestri (que tem TTY) poderia chamar o comando. Mitigação: não dar ao agente do Maestri acesso ao state dir e usar o OpenCode com permissão "ask".
18. **`opencode_run` sempre pede aprovação.** O OpenCode tem shell e arquivos próprios; sem o portão, o pet poderia mandá-lo escrever uma aprovação em `approvals/` ou rodar qualquer coisa (achado do review de segurança). `maestri_ask` continua só auditado: risco residual, use permissão "ask" no OpenCode/agentes do Maestri. Os registros de aprovação não têm assinatura: quem escreve no state dir aprova.
19. **Hub só escuta em loopback ou Tailscale** (100.64.0.0/10, fd7a:115c:a1e0::/48). Outro endereço exige `PET_HUB_ALLOW_ANY_HOST=1`.
20. **Token no primeiro frame do WebSocket, nunca na URL.** 256 bits, arquivo 0600, comparação por hash em tempo constante, 5 falhas = 60 s de bloqueio por IP, 5 s para autenticar, checagem de Origin, payload máx. 64KB, máx. 8 clientes.
21. **HTTP serve só 3 arquivos fixos**, com CSP, nosniff e no-store. A UI usa `textContent` e nenhum script/estilo inline.
22. **Desktop em Electron, não Tauri.** `webkit2gtk-4.1` não está instalado e não instalamos pacotes de sistema. Janela com sandbox + contextIsolation; o token só vai para a origem do hub.
23. **Android em Java, sem Gradle.** Não há Gradle/kotlinc na máquina; `build.sh` usa aapt2/javac/d8/zipalign/apksigner. Tráfego HTTP simples porque o Tailscale já cifra; token em SharedPreferences privado (`allowBackup=false`). Não testado em aparelho.
24. **Limites aceitos:** DNS rebinding só é barrado pelo token + Origin; ferramentas de leitura podem ler arquivos não sensíveis do PC; `git` em repositório não confiável pode executar hooks.
25. **Review de segurança (feito e aplicado):** `opencode_run` com portão; paths sensíveis ampliados (`.claude`, `hosts.yml`, `*history`, `.config/gh|op`); checagem de `Host` (421 em DNS rebinding); sockets sem auth limitados a 2 por IP e timeout de auth conta como falha; bloqueio por IP expira; CSP `connect-src 'self'`; token com `chmod 600` forçado; Electron nega permissões e bloqueia redirect/frame-navigate; Android só aceita https ou http com IP do Tailscale.
26. **Aceito sem mudar:** erro do agente (stderr, até 500 caracteres) aparece no chat do dono; aprovar `danger` é um clique (a ação completa aparece na tela); o token fica em localStorage no modo navegador; o Electron entrega o token a qualquer processo que ocupe a porta do hub se ele estiver fora do ar; o Android usa `addJavascriptInterface` restrito ao host do hub.
