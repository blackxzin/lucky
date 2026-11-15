import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { UserFacingError } from "../errors.js";
import type { HubCore, HubState } from "./core.js";
import { createLockout } from "./lockout.js";
import type { MediaController } from "./media.js";
import { parseClientMessage } from "./protocol.js";
import { tokenMatches } from "./token.js";

const WS_PATH = "/ws";
const PENDING_PATH = "/api/pending";
const BEARER_PREFIX = "Bearer ";
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_CLIENTS = 8;
const MAX_UNAUTHENTICATED_PER_ADDRESS = 2;
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];
const DEFAULT_POLL_MS = 1500;
const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const DEFAULT_PENDING_WAIT_MS = 25_000;
const CLOSE_UNAUTHORIZED = 4401;

/** Só estes arquivos saem do disco; o caminho pedido nunca vira caminho de arquivo. */
const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export interface HubServerOptions {
  core: HubCore;
  token: string;
  uiDir: string;
  host: string;
  port: number;
  pollMs?: number;
  authTimeoutMs?: number;
  /** Quanto /api/pending?since=... espera por uma mudança antes de responder igual. */
  pendingWaitMs?: number;
  /** Controle de música do PC. Sem ele, pedidos "media" são recusados. */
  media?: MediaController;
  now?: () => number;
}

export interface HubServer {
  /** Devolve a porta em que ficou escutando. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

function logError(context: string, error: unknown): void {
  process.stderr.write(`[pet-hub] ${context}: ${error instanceof Error ? error.message : String(error)}\n`);
}

function pathOf(request: IncomingMessage): string {
  return (request.url ?? "/").split("?")[0] ?? "/";
}

/** Uma página de outro site não pode abrir o socket, mesmo que descubra o token. */
function isForeignOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== request.headers.host;
  } catch {
    return true;
  }
}

/** Nomes pelos quais o hub aceita ser chamado. Barra DNS rebinding: o navegador manda o nome do atacante em Host. */
function allowedHostHeaders(host: string, port: number): Set<string> | undefined {
  if (WILDCARD_HOSTS.has(host)) return undefined;
  const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const names = isLoopback ? LOOPBACK_NAMES : [host.includes(":") ? `[${host}]` : host];
  return new Set(names.map((name) => `${name}:${port}`));
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createHubServer(options: HubServerOptions): HubServer {
  const { core, token, uiDir, host, port } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const pendingWaitMs = options.pendingWaitMs ?? DEFAULT_PENDING_WAIT_MS;
  const lockout = createLockout(options.now ?? Date.now);

  let allowedHosts: Set<string> | undefined;
  const isAllowedHost = (request: IncomingMessage): boolean =>
    allowedHosts === undefined || allowedHosts.has((request.headers.host ?? "").toLowerCase());

  const authenticated = new Set<WebSocket>();
  /** Qual aparelho (pc, celular) é cada socket autenticado; só quem se identificou entra. */
  const devices = new Map<WebSocket, string>();
  /** Quais aparelhos estão dormindo (o próprio pet avisa): o outro pet pode acordar ou assustar quem dorme. */
  const sleeping = new Set<WebSocket>();
  const pendingByAddress = new Map<string, number>();
  const send = (socket: WebSocket, payload: unknown): void => socket.send(JSON.stringify(payload));
  const sendHabits = (socket: WebSocket): void => {
    core.listHabits().then(
      (items) => send(socket, { type: "habits", items }),
      (error: unknown) => logError("falha ao listar hábitos", error),
    );
  };
  const asleepNames = (): string[] => [...new Set([...sleeping].map((socket) => devices.get(socket) ?? "unknown"))].sort();
  const broadcastAsleep = (): void => {
    const names = asleepNames();
    authenticated.forEach((socket) => send(socket, { type: "asleep", devices: names }));
  };
  const broadcastPeers = (): void => {
    const names = [...new Set(devices.values())].sort();
    authenticated.forEach((socket) => send(socket, { type: "peers", devices: names }));
  };

  interface PendingView {
    approvals: Array<{ id: string; tool: string; risk: string }>;
    busy: boolean;
    sig: string;
  }

  /** Só id, ferramenta e risco: a notificação aparece na tela bloqueada. `sig` identifica o estado para o long-poll. */
  const pendingView = (state: HubState): PendingView => {
    const approvals = state.approvals.map(({ id, tool, risk }) => ({ id, tool, risk }));
    return { approvals, busy: state.busy, sig: `${state.busy ? 1 : 0}:${approvals.map((approval) => approval.id).join(",")}` };
  };

  /** Espera o estado deixar de ser `since` (ou o tempo acabar, ou o cliente sair). */
  const waitForChange = (since: string, current: PendingView, request: IncomingMessage): Promise<PendingView> =>
    new Promise((resolve) => {
      let latest = current;
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(latest);
      };
      const timer = setTimeout(finish, pendingWaitMs);
      const unsubscribe = core.subscribe((event) => {
        if (event.type !== "state") return;
        latest = pendingView(event.state);
        if (latest.sig !== since) finish();
      });
      request.on("close", finish);
    });

  /**
   * Aviso de aprovações e humor para o celular (que não mantém o WebSocket aberto). Mesmo token e mesma trava
   * de tentativas do socket. Com `?since=<sig>` vira long-poll: só responde quando o estado muda.
   */
  const servePending = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const address = request.socket.remoteAddress ?? "unknown";
    if (lockout.isLocked(address)) {
      response.writeHead(429, SECURITY_HEADERS).end();
      return;
    }
    const header = request.headers.authorization ?? "";
    const presented = header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : "";
    if (!tokenMatches(token, presented)) {
      lockout.fail(address);
      response.writeHead(401, SECURITY_HEADERS).end();
      return;
    }
    lockout.succeed(address);
    const since = new URL(request.url ?? "/", "http://hub").searchParams.get("since");
    let view = pendingView((await core.snapshot()).state);
    if (since !== null && since === view.sig) view = await waitForChange(since, view, request);
    if (response.destroyed) return;
    response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(view));
  };

  const serveAsset = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isAllowedHost(request)) {
      response.writeHead(421, SECURITY_HEADERS).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, SECURITY_HEADERS).end();
      return;
    }
    if (pathOf(request) === PENDING_PATH) {
      if (request.method !== "GET") {
        response.writeHead(405, SECURITY_HEADERS).end();
        return;
      }
      await servePending(request, response);
      return;
    }
    const asset = ASSETS[pathOf(request)];
    if (asset === undefined) {
      response.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    const body = await readFile(join(uiDir, asset.file));
    response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": asset.type }).end(request.method === "HEAD" ? undefined : body);
  };

  const http: Server = createServer((request, response) => {
    serveAsset(request, response).catch((error: unknown) => {
      logError("falha ao servir a interface", error);
      if (!response.headersSent) response.writeHead(500, SECURITY_HEADERS);
      response.end();
    });
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  /** Sockets que já deixaram de contar como "sem login". Um socket só é solto uma vez. */
  const released = new WeakSet<WebSocket>();
  const releasePending = (socket: WebSocket, address: string): void => {
    if (released.has(socket)) return;
    released.add(socket);
    const left = (pendingByAddress.get(address) ?? 1) - 1;
    if (left > 0) pendingByAddress.set(address, left);
    else pendingByAddress.delete(address);
  };

  /** Recusa o socket já liberando a vaga: o fechamento termina depois, e esperar por ele deixaria o contador preso sob carga. */
  const reject = (socket: WebSocket, address: string): void => {
    lockout.fail(address);
    releasePending(socket, address);
    socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
  };

  const handleMessage = (socket: WebSocket, address: string, raw: string): void => {
    const message = parseClientMessage(raw);

    if (!authenticated.has(socket)) {
      if (message?.type === "auth" && tokenMatches(token, message.token)) {
        lockout.succeed(address);
        authenticated.add(socket);
        if (message.device !== undefined) devices.set(socket, message.device);
        releasePending(socket, address);
        core
          .snapshot()
          .then((snapshot) => {
            send(socket, { type: "hello", ...snapshot });
            if (devices.has(socket)) broadcastPeers();
            if (sleeping.size > 0) send(socket, { type: "asleep", devices: asleepNames() });
          })
          .catch((error: unknown) => logError("falha ao montar o estado", error));
        return;
      }
      reject(socket, address);
      return;
    }

    if (message === undefined || message.type === "auth") {
      send(socket, { type: "error", text: "Mensagem inválida." });
      return;
    }
    if (message.type === "ping") {
      send(socket, { type: "pong" });
      return;
    }
    if (message.type === "sleep") {
      if (!devices.has(socket) || sleeping.has(socket) === message.asleep) return;
      if (message.asleep) sleeping.add(socket);
      else sleeping.delete(socket);
      broadcastAsleep();
      return;
    }
    if (message.type === "signal") {
      const from = devices.get(socket) ?? "unknown";
      authenticated.forEach((other) => other !== socket && send(other, { type: "signal", kind: message.kind, from }));
      return;
    }
    if (message.type === "reminders") {
      core.listReminders().then(
        (items) => send(socket, { type: "reminders", items }),
        (error: unknown) => logError("falha ao listar lembretes", error),
      );
      return;
    }
    if (message.type === "reminder_add" || message.type === "reminder_cancel") {
      const work = message.type === "reminder_add" ? core.addReminder(message.text, message.inMinutes) : core.cancelReminder(message.id);
      work.catch((error: unknown) => {
        if (error instanceof UserFacingError) send(socket, { type: "error", text: error.message });
        else logError("falha ao mexer em lembrete", error);
      });
      return;
    }
    if (message.type === "habits") {
      sendHabits(socket);
      return;
    }
    if (message.type === "habit_add" || message.type === "habit_done" || message.type === "habit_remove") {
      const work =
        message.type === "habit_add"
          ? core.addHabit(message.name, message.everyMinutes)
          : message.type === "habit_done"
            ? core.doneHabit(message.id)
            : core.removeHabit(message.id);
      work.then(() => authenticated.forEach(sendHabits)).catch((error: unknown) => {
        if (error instanceof UserFacingError) send(socket, { type: "error", text: error.message });
        else logError("falha ao mexer em hábito", error);
      });
      return;
    }
    if (message.type === "media") {
      if (options.media === undefined) {
        send(socket, { type: "error", text: "Música indisponível neste aparelho." });
        return;
      }
      options.media(message.action).then(
        (status) => send(socket, { type: "media", ...status }),
        (error: unknown) => {
          logError("falha no controle de música", error);
          send(socket, { type: "error", text: "Não consegui controlar a música." });
        },
      );
      return;
    }
    const work = message.type === "chat" ? core.chat(message.text) : core.decide(message.id, message.approved);
    work.catch((error: unknown) => logError("falha ao processar mensagem", error));
  };

  sockets.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const address = request.socket.remoteAddress ?? "unknown";
    pendingByAddress.set(address, (pendingByAddress.get(address) ?? 0) + 1);
    const authTimer = setTimeout(() => {
      if (authenticated.has(socket)) return;
      reject(socket, address);
    }, authTimeoutMs);

    socket.on("message", (data) => handleMessage(socket, address, String(data)));
    socket.on("error", (error) => logError("erro no socket", error));
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (!authenticated.delete(socket)) releasePending(socket, address);
      else if (devices.delete(socket)) {
        const wasAsleep = sleeping.delete(socket);
        broadcastPeers();
        if (wasAsleep) broadcastAsleep();
      }
    });
  });

  http.on("upgrade", (request, socket, head) => {
    if (pathOf(request) !== WS_PATH) return refuse(socket, 404, "Not Found");
    if (!isAllowedHost(request)) return refuse(socket, 421, "Misdirected Request");
    if (isForeignOrigin(request)) return refuse(socket, 403, "Forbidden");
    const address = request.socket.remoteAddress ?? "unknown";
    if (lockout.isLocked(address)) return refuse(socket, 429, "Too Many Requests");
    if ((pendingByAddress.get(address) ?? 0) >= MAX_UNAUTHENTICATED_PER_ADDRESS) return refuse(socket, 429, "Too Many Requests");
    if (sockets.clients.size >= MAX_CLIENTS) return refuse(socket, 503, "Service Unavailable");
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
  });

  const unsubscribe = core.subscribe((event) => authenticated.forEach((socket) => send(socket, event)));

  const poll = setInterval(() => {
    if (authenticated.size === 0) return;
    core.refresh().catch((error: unknown) => logError("falha ao reler aprovações", error));
  }, pollMs);
  poll.unref();

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          const bound = (http.address() as AddressInfo).port;
          allowedHosts = allowedHostHeaders(host, bound);
          resolve(bound);
        });
      }),

    close: () =>
      new Promise((resolve) => {
        clearInterval(poll);
        unsubscribe();
        sockets.clients.forEach((socket) => socket.terminate());
        sockets.close();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
