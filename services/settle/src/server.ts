/**
 * The settlement service's web surface: what the merchant app needs to cash
 * out, and where paj.cash reports back.
 *
 *   GET  /v1/health
 *   GET  /v1/rate                              paj.cash's off-ramp rate
 *   GET  /v1/banks                             banks paj.cash pays
 *   GET  /v1/banks/:code/accounts/:account     whose account this is
 *   POST /v1/cashouts            { id, merchant, destination, amount }
 *   GET  /v1/cashouts/:id        where it stands, asked of paj.cash
 *   POST /v1/cashouts/:id/funded { signature }
 *   POST /v1/paj/webhook/:secret a prompt to ask paj.cash again
 *
 * A bearer token keeps drive-by traffic out, as on the relayer; it ships in
 * the app, so it is not a secret from anyone holding the APK. The webhook
 * cannot carry it, so its path carries a secret of its own instead, and its
 * body is never believed: it only says which order to ask about.
 *
 * Writes are handled one at a time: two requests for one cash-out id must
 * not both open an order.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { byReference, markFunded, openCashout, refresh, type CashoutDeps, type CashoutStore } from "./cashout.ts";
import { PajError } from "./paj/client.ts";
import type { PajPartner } from "./paj/partner.ts";

export interface SettleOptions {
  partner: PajPartner;
  store: CashoutStore;
  /** Unix milliseconds. */
  now: () => number;
  token?: string;
  webhookSecret: string;
  tokenCurrency: string;
  localCurrency: string;
  limits: CashoutDeps["limits"];
  /** How long a rate is reused. Default 60 s. */
  rateTtlMs?: number;
}

function serial(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>) => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
}

export function buildSettle(options: SettleOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 4096 });
  const serially = serial();
  let rate: { at: number; body: unknown } | null = null;

  const failed = (reply: { code(n: number): { send(b: unknown): unknown } }, e: unknown) => {
    if (e instanceof PajError && e.session) return reply.code(503).send({ error: e.message, login: true });
    return reply.code(503).send({ error: e instanceof Error ? e.message : "unavailable" });
  };

  app.addHook("onRequest", async (request, reply) => {
    if (!options.token || request.url === "/v1/health" || request.url.startsWith("/v1/paj/webhook/")) return;
    if (request.headers.authorization !== `Bearer ${options.token}`) return reply.code(401).send({ error: "unauthorised" });
  });

  app.get("/v1/health", async () => ({ partner: options.partner.name, fidelity: options.partner.fidelity }));

  app.get("/v1/rate", async (_request, reply) => {
    const now = options.now();
    if (rate && now - rate.at < (options.rateTtlMs ?? 60_000)) return rate.body;
    try {
      const r = await options.partner.rate();
      const body = {
        partner: options.partner.name,
        fidelity: options.partner.fidelity,
        currency: options.localCurrency,
        rate: String(r.rate),
        localPerToken: r.conversion.localPerToken.toString(),
        scale: r.conversion.scale,
        at: now,
      };
      rate = { at: now, body };
      return body;
    } catch (e) {
      return failed(reply, e);
    }
  });

  app.get("/v1/banks", async (_request, reply) => {
    try {
      return (await options.partner.banks()).map((b) => ({ code: b.code, name: b.name }));
    } catch (e) {
      return failed(reply, e);
    }
  });

  app.get("/v1/banks/:code/accounts/:account", async (request, reply) => {
    const { code, account } = request.params as { code: string; account: string };
    if (!/^\d{3,6}$/.test(code) || !/^\d{10}$/.test(account)) return reply.code(400).send({ error: "a bank code and a 10-digit account" });
    try {
      const r = await options.partner.resolve(code, account);
      if (!r) return reply.code(404).send({ error: "paj.cash does not list that bank" });
      return { accountName: r.accountName, bank: r.bank.name };
    } catch (e) {
      if (e instanceof PajError && !e.session && e.status >= 400 && e.status < 500) {
        return reply.code(404).send({ error: "that account could not be found" });
      }
      return failed(reply, e);
    }
  });

  const deps = (): CashoutDeps => ({
    store: options.store,
    partner: options.partner,
    now: options.now(),
    tokenCurrency: options.tokenCurrency,
    localCurrency: options.localCurrency,
    limits: options.limits,
  });

  app.post("/v1/cashouts", async (request, reply) => {
    const b = request.body as { id?: unknown; merchant?: unknown; destination?: unknown; amount?: unknown } | null;
    if (
      !b ||
      typeof b.id !== "string" ||
      typeof b.merchant !== "string" ||
      typeof b.destination !== "string" ||
      typeof b.amount !== "string" ||
      !/^\d{1,20}$/.test(b.amount)
    ) {
      return reply.code(400).send({ error: "expected { id, merchant, destination, amount: base units as a string }" });
    }
    const input = { id: b.id, merchant: b.merchant, destination: b.destination, tokenMinor: BigInt(b.amount) };
    try {
      const r = await serially(() => openCashout(input, deps()));
      return r.ok ? r.cashout : reply.code(r.retryable ? 429 : 422).send({ error: r.reason });
    } catch (e) {
      return failed(reply, e);
    }
  });

  app.get("/v1/cashouts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const c = await serially(() => refresh(id, deps()));
      return c ?? reply.code(404).send({ error: "no such cash-out" });
    } catch {
      // paj.cash unreachable: what is known, marked as not freshly checked.
      const c = options.store.read().cashouts[id];
      return c ? { ...c, stale: true } : reply.code(404).send({ error: "no such cash-out" });
    }
  });

  app.post("/v1/cashouts/:id/funded", async (request, reply) => {
    const { id } = request.params as { id: string };
    const b = request.body as { signature?: unknown } | null;
    if (!b || typeof b.signature !== "string") return reply.code(400).send({ error: "expected { signature }" });
    const r = await serially(async () => markFunded(id, b.signature as string, { store: options.store, now: options.now() }));
    return r.ok ? r.cashout : reply.code(422).send({ error: r.reason });
  });

  app.post("/v1/paj/webhook/:secret", async (request, reply) => {
    const { secret } = request.params as { secret: string };
    if (secret !== options.webhookSecret) return reply.code(404).send({ error: "not found" });
    const b = request.body as { id?: unknown } | null;
    const c = b && typeof b.id === "string" ? byReference(options.store, b.id) : null;
    // Acknowledged either way, quickly; the order is asked about, not believed.
    if (c) await serially(() => refresh(c.id, deps())).catch(() => null);
    return { received: true };
  });

  return app;
}
