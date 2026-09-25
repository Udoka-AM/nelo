/**
 * The relayer's web surface: one endpoint that matters.
 *
 *   POST /v1/redeem   { "packet": "<202 bytes, base64>" }  → RedeemResponse
 *   POST /v1/conflict { "a": "<base64>", "b": "<base64>" } → ConflictResponse
 *   POST /v1/cashout/prepare { order, owner, deposit, amount } → the transfer to sign
 *   POST /v1/cashout/submit  { order, wire }                   → its signature
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
import { reportConflict, sweep, type ConflictRpc } from "./conflict.ts";
import { prepareCashout, submitCashout, type CashoutLimits } from "./cashout.ts";

export interface ServerOptions {
  deps: Omit<RedeemDeps, "now" | "rpc"> & { rpc: ConflictRpc };
  /** Unix seconds. */
  now: () => number;
  /** When set, requests must carry `authorization: Bearer <token>`. */
  token?: string;
  /** Cash-out transfers. Omitted: the endpoints answer 404. */
  cashout?: { limits: Omit<CashoutLimits, "budgetLamports">; decimals: number };
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

export interface Relay {
  app: FastifyInstance;
  /** Slash every frozen, reported vault that still holds stake. Serialised with requests. */
  sweep(): ReturnType<typeof sweep>;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  return buildRelay(options).app;
}

export function buildRelay(options: ServerOptions): Relay {
  const app = Fastify({ logger: false, bodyLimit: 2048 });
  const serially = serial();
  const conflictDeps = () => ({
    rpc: options.deps.rpc,
    feePayer: options.deps.feePayer,
    ledger: options.deps.ledger,
    limits: options.deps.config.limits,
    ...(options.deps.config.programId ? { programId: options.deps.config.programId } : {}),
    now: options.now(),
  });

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
      return await serially(async () => {
        const answer = await redeem(packet, { ...options.deps, now: options.now() });
        // Asked to pay for a second, different voucher at a sequence it already
        // submitted: the relayer is holding a double spend. Report it now.
        if (answer.status === "declined" && answer.conflictWith) {
          const other = new Uint8Array(Buffer.from(answer.conflictWith, "base64"));
          const report = await reportConflict(other, packet, conflictDeps()).catch(() => null);
          const { conflictWith: _, ...rest } = answer;
          return { ...rest, conflict: true, reported: report?.status ?? "failed" };
        }
        return answer;
      });
    } catch (e) {
      // The RPC was unreachable before anything was sent. The till treats a
      // 503 as "offline" and asks again later.
      return reply.code(503).send({ error: e instanceof Error ? e.message : "unavailable" });
    }
  });

  app.post("/v1/conflict", async (request, reply) => {
    const body = request.body as { a?: unknown; b?: unknown } | null;
    if (!body || typeof body.a !== "string" || typeof body.b !== "string") {
      return reply.code(400).send({ error: "expected { a: base64, b: base64 }" });
    }
    const a = new Uint8Array(Buffer.from(body.a, "base64"));
    const b = new Uint8Array(Buffer.from(body.b, "base64"));
    if (a.length !== 202 || b.length !== 202) return reply.code(400).send({ error: "each voucher is 202 bytes" });
    try {
      return await serially(() => reportConflict(a, b, conflictDeps()));
    } catch (e) {
      return reply.code(503).send({ error: e instanceof Error ? e.message : "unavailable" });
    }
  });

  const cashoutDeps = () => ({
    rpc: options.deps.rpc,
    feePayer: options.deps.feePayer,
    ledger: options.deps.ledger,
    mint: options.deps.config.mint,
    decimals: options.cashout!.decimals,
    ...(options.deps.config.tokenProgram ? { tokenProgram: options.deps.config.tokenProgram } : {}),
    limits: { ...options.cashout!.limits, budgetLamports: options.deps.config.limits.budgetLamports },
    now: options.now(),
  });

  app.post("/v1/cashout/prepare", async (request, reply) => {
    if (!options.cashout) return reply.code(404).send({ error: "cash-outs are not enabled" });
    const body = request.body as { order?: unknown; owner?: unknown; deposit?: unknown; amount?: unknown } | null;
    if (
      !body ||
      typeof body.order !== "string" ||
      typeof body.owner !== "string" ||
      typeof body.deposit !== "string" ||
      typeof body.amount !== "string" ||
      !/^\d{1,20}$/.test(body.amount)
    ) {
      return reply.code(400).send({ error: "expected { order, owner, deposit, amount: base units as a string }" });
    }
    const input = { order: body.order, owner: body.owner, deposit: body.deposit, amount: BigInt(body.amount) };
    try {
      return await serially(() => prepareCashout(input, cashoutDeps()));
    } catch (e) {
      return reply.code(503).send({ error: e instanceof Error ? e.message : "unavailable" });
    }
  });

  app.post("/v1/cashout/submit", async (request, reply) => {
    if (!options.cashout) return reply.code(404).send({ error: "cash-outs are not enabled" });
    const body = request.body as { order?: unknown; wire?: unknown } | null;
    if (!body || typeof body.order !== "string" || typeof body.wire !== "string") {
      return reply.code(400).send({ error: "expected { order, wire: base64 }" });
    }
    const wire = new Uint8Array(Buffer.from(body.wire, "base64"));
    try {
      return await serially(() => submitCashout(body.order as string, wire, cashoutDeps()));
    } catch (e) {
      return reply.code(503).send({ error: e instanceof Error ? e.message : "unavailable" });
    }
  });

  return { app, sweep: () => serially(() => sweep(conflictDeps())) };
}
