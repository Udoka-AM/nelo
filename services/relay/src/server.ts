/**
 * The relayer's web surface: one endpoint that matters.
 *
 *   POST /v1/redeem   { "packet": "<202 bytes, base64>" }  → RedeemResponse
 *   GET  /v1/health   who pays, and for which mint
 *
 * Requests are handled one at a time. The ledger is read, decided on and
 * written per request, and two interleaved requests for one voucher are the
 * exact race the ledger exists to prevent.
 *
 * A bearer token keeps drive-by traffic out. It ships inside the merchant app,
 * so it is not a secret from anyone holding the APK. What bounds the cost of
 * abuse is the policy: signature-verified vouchers only, a daily budget, a
 * per-vault cap, and one funded token account per merchant.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { redeem, type RedeemDeps } from "./redeem.ts";

export interface ServerOptions {
  deps: Omit<RedeemDeps, "now">;
  /** Unix seconds. */
  now: () => number;
  /** When set, requests must carry `authorization: Bearer <token>`. */
  token?: string;
}

/** Run async work one at a time, in arrival order. */
export function serial(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2048 });
  const serially = serial();

  app.addHook("onRequest", async (request, reply) => {
    if (!options.token || request.url === "/v1/health") return;
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      return reply.code(401).send({ error: "unauthorised" });
    }
  });

  app.get("/v1/health", async () => ({
    feePayer: options.deps.feePayer.address,
    mint: options.deps.config.mint,
  }));

  app.post("/v1/redeem", async (request, reply) => {
    const body = request.body as { packet?: unknown } | null;
    if (!body || typeof body.packet !== "string") {
      return reply.code(400).send({ error: "expected { packet: base64 }" });
    }
    const packet = new Uint8Array(Buffer.from(body.packet, "base64"));
    if (packet.length !== 202) {
      return reply.code(400).send({ error: `a voucher is 202 bytes, got ${packet.length}` });
    }
    try {
      return await serially(() => redeem(packet, { ...options.deps, now: options.now() }));
    } catch (e) {
      // The RPC was unreachable before anything was sent. The till treats a
      // 503 as "offline" and asks again later.
      return reply.code(503).send({ error: e instanceof Error ? e.message : "unavailable" });
    }
  });

  return app;
}
