import { z } from "zod";
import { findSecret } from "../vault/secrets.js";
import { gated } from "./gate.js";
import { approvalIdSchema } from "./maestri.js";
import { guarded, ToolError, type ServerDeps, type ToolRegistrar } from "./shared.js";

const OPEN_TIMEOUT_MS = 5000;
const MAX_QUERY_CHARS = 200;
const MAX_URL_CHARS = 2000;
const MAX_DRAFT_CHARS = 1000;

/** Programas que o pet pode abrir. O pedido só escolhe uma chave daqui; nunca monta comando. */
const APPS = {
  firefox: "firefox",
  obsidian: "obsidian",
  spotify: "spotify",
  discord: "discord",
  arquivos: "thunar",
  terminal: "kitty",
  vscode: "code",
} as const;
type AppName = keyof typeof APPS;
const APP_NAMES = Object.keys(APPS) as [AppName, ...AppName[]];

const SEARCH_ENGINES = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  youtube: "https://www.youtube.com/results?search_query=",
} as const;
type Engine = keyof typeof SEARCH_ENGINES;

/** Sites que abrem direto. Qualquer outro pede aprovação: a URL é o caminho clássico para vazar dado. */
const KNOWN_HOSTS = [
  "youtube.com",
  "youtu.be",
  "github.com",
  "wikipedia.org",
  "web.whatsapp.com",
  "duckduckgo.com",
  "google.com",
  "maps.google.com",
  "mail.google.com",
  "calendar.google.com",
  "stackoverflow.com",
  "mozilla.org",
];

const WHATSAPP_PHONE = /^\d{10,15}$/;

const isKnownHost = (host: string): boolean => KNOWN_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));

function refuseSecret(text: string, where: string): void {
  const secret = findSecret(text);
  if (secret !== undefined) throw new ToolError(`${where} parece conter um segredo (${secret}). Não vou mandar para fora do PC.`);
}

/** URL https sem usuário/senha, sem segredo e de tamanho razoável. Devolve a forma normalizada. */
function parseWebUrl(raw: string): URL {
  if (raw.length > MAX_URL_CHARS) throw new ToolError("URL grande demais.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError("URL inválida.");
  }
  if (url.protocol !== "https:") throw new ToolError("Só abro endereços https.");
  if (url.username !== "" || url.password !== "") throw new ToolError("URL com usuário ou senha não é aceita.");
  refuseSecret(decodeURIComponent(url.href), "A URL");
  return url;
}

async function openWith(deps: ServerDeps, bin: string, args: readonly string[]): Promise<void> {
  const result = await deps.run(bin, args, { timeoutMs: OPEN_TIMEOUT_MS });
  if (result.exitCode !== 0) throw new ToolError(`Não consegui abrir (${bin} saiu com ${String(result.exitCode)}).`);
}

const auto = (reason: string) => ({ risk: "safe" as const, reason });

export const registerOpenTools: ToolRegistrar = (server, deps) => {
  server.registerTool(
    "pc_open_app",
    {
      description: `Abre um programa no PC do dono. Só estes: ${APP_NAMES.join(", ")}.`,
      inputSchema: { app: z.enum(APP_NAMES) },
    },
    ({ app }) =>
      guarded(() =>
        gated(deps, {
          tool: "pc_open_app",
          action: app,
          classification: auto("programa da lista"),
          approvalId: undefined,
          execute: async () => {
            await openWith(deps, "setsid", ["-f", APPS[app]]);
            return `Abri ${app}.`;
          },
        }),
      ),
  );

  server.registerTool(
    "pc_search",
    {
      description:
        "Abre no navegador do dono uma pesquisa (duckduckgo, google ou youtube). Para ELE ver a página. Nunca ponha segredo ou dado pessoal na busca.",
      inputSchema: { query: z.string().min(1).max(MAX_QUERY_CHARS), engine: z.enum(["duckduckgo", "google", "youtube"]).optional() },
    },
    ({ query, engine = "duckduckgo" }) =>
      guarded(() => {
        refuseSecret(query, "A busca");
        const url = `${SEARCH_ENGINES[engine as Engine]}${encodeURIComponent(query)}`;
        return gated(deps, {
          tool: "pc_search",
          action: `${engine}: ${query}`,
          classification: auto("busca montada pela ferramenta"),
          approvalId: undefined,
          execute: async () => {
            await openWith(deps, "xdg-open", [url]);
            return `Abri a busca "${query}" em ${engine}.`;
          },
        });
      }),
  );

  server.registerTool(
    "pc_open_url",
    {
      description:
        "Abre um endereço https no navegador do dono. Sites conhecidos (youtube, github, wikipedia...) abrem direto; qualquer outro volta um pedido de aprovação. Nunca ponha dado do dono na URL.",
      inputSchema: { url: z.string().min(1).max(MAX_URL_CHARS), approvalId: approvalIdSchema },
    },
    ({ url: raw, approvalId }) =>
      guarded(() => {
        const url = parseWebUrl(raw);
        return gated(deps, {
          tool: "pc_open_url",
          action: url.href,
          classification: isKnownHost(url.hostname) ? auto("site conhecido") : { risk: "confirm", reason: "abre um site fora da lista conhecida" },
          approvalId,
          execute: async () => {
            await openWith(deps, "xdg-open", [url.href]);
            return `Abri ${url.hostname}.`;
          },
        });
      }),
  );

  server.registerTool(
    "whatsapp_draft",
    {
      description:
        "Abre o WhatsApp Web na conversa do número com o texto já digitado, SEM enviar: o dono confere e aperta Enter. phone = só dígitos com DDI e DDD (ex.: 5511999998888). Diga ao dono o que deixou escrito.",
      inputSchema: { phone: z.string().min(1).max(30), text: z.string().min(1).max(MAX_DRAFT_CHARS) },
    },
    ({ phone, text }) =>
      guarded(() => {
        if (!WHATSAPP_PHONE.test(phone)) throw new ToolError("O número precisa ter só dígitos, com DDI e DDD (10 a 15 dígitos).");
        refuseSecret(text, "A mensagem");
        const url = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(text)}`;
        return gated(deps, {
          tool: "whatsapp_draft",
          action: `rascunho para ${phone}: ${text}`,
          classification: auto("só abre o rascunho; quem envia é o dono"),
          approvalId: undefined,
          execute: async () => {
            await openWith(deps, "xdg-open", [url]);
            return "Abri a conversa com o rascunho. NÃO foi enviado: o dono confere e aperta Enter.";
          },
        });
      }),
  );
};
