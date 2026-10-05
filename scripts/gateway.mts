/**
 * One local entry point for Nelo's two services, so one public address can
 * front both.
 *
 *   pnpm gateway            listens on 127.0.0.1:8790
 *
 *   /settle/…   → the settlement service (127.0.0.1:8788), "/settle" removed
 *   anything else → the relayer        (127.0.0.1:8787)
 *
 * Why: a release APK has the relay's and the settlement service's addresses
 * compiled in, so they must never change, and must be https (Android refuses
 * plain http outside development builds). ngrok's free plan gives one fixed
 * https address and connects out on port 443, which works on networks that
 * block cloudflared's port 7844. One address, two services: this splits it.
 *
 * Point the public address at this port:
 *   ngrok http 8790 --url=https://<your-domain>.ngrok-free.app
 * then
 *   pnpm setup:env --relay-url https://<your-domain>.ngrok-free.app \
 *                  --settle-url https://<your-domain>.ngrok-free.app/settle
 *
 * No dependencies. Bodies are streamed, never buffered or logged: they carry
 * signed vouchers and bearer tokens. Each request is logged as one line,
 * method, path (without the webhook's secret) and status.
 */
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";

const port = Number(process.env.GATEWAY_PORT ?? "8790");
const host = process.env.GATEWAY_HOST?.trim() || "127.0.0.1";
const relayPort = Number(process.env.RELAY_PORT ?? "8787");
const settlePort = Number(process.env.SETTLE_PORT ?? "8788");

/** Where a request goes, and the path the service sees. */
export function route(url: string): { port: number; path: string; service: "relay" | "settle" } {
  if (url === "/settle" || url.startsWith("/settle/") || url.startsWith("/settle?")) {
    const rest = url.slice("/settle".length);
    return { port: settlePort, path: rest.startsWith("/") ? rest : `/${rest}`, service: "settle" };
  }
  return { port: relayPort, path: url, service: "relay" };
}

/** The webhook path carries a secret; never print it. */
const printable = (path: string) => path.replace(/(\/webhook\/)[^/?]+/, "$1…");

function forward(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? "/";
  if (url === "/gateway/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ gateway: "ok", relay: relayPort, settle: settlePort }));
    return;
  }
  const to = route(url);
  const headers = { ...req.headers, host: `127.0.0.1:${to.port}` };
  const upstream = request(
    { host: "127.0.0.1", port: to.port, method: req.method, path: to.path, headers },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
      console.log(`${req.method} ${to.service} ${printable(to.path)} → ${answer.statusCode}`);
    },
  );
  upstream.on("error", (e) => {
    console.warn(`${req.method} ${to.service} ${printable(to.path)} → not running (${(e as NodeJS.ErrnoException).code ?? e.message})`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `the ${to.service} service is not running on port ${to.port}` }));
    } else res.destroy();
  });
  req.pipe(upstream);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer(forward).listen(port, host, () => {
    console.log(`nelo gateway on http://${host}:${port} · /settle → :${settlePort} · everything else → :${relayPort}`);
  });
}
