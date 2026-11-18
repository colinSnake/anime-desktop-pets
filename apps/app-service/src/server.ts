import Fastify from "fastify";
import { registerPetRoutes } from "./pet-routes.ts";
import type { PetWorkspace } from "./pet-workspace.ts";
import { timingSafeEqual } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type RuntimeController,
  type PlayerController,
  type Snapshot,
} from "../../../packages/contracts/src/index.ts";
import { platformCapabilities } from "./platform.ts";

export function createService({
  token,
  runtime,
  player,
  workspace,
}: {
  token: string;
  runtime: RuntimeController;
  player?: PlayerController;
  workspace?: PetWorkspace;
}) {
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error("Invalid session credential");
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const authorization = Buffer.from(`Bearer ${token}`);
  app.addHook("onRequest", async (request, reply) => {
    const address = app.server.address();
    const expectedHost =
      address && typeof address === "object"
        ? `127.0.0.1:${address.port}`
        : "127.0.0.1";
    if (
      request.headers.host !== expectedHost ||
      request.headers.origin !== undefined ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (
      supplied.length !== authorization.length ||
      !timingSafeEqual(supplied, authorization)
    )
      return reply.code(401).send({ error: "unauthorized" });
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff");
  });
  app.setErrorHandler((error, _request, reply) => {
    const code =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const status =
      typeof code === "number" && code >= 400 && code < 500 ? code : 503;
    reply.code(status).send({
      error: status === 503 ? "service_unavailable" : "invalid_request",
    });
  });
  const snapshot = (): Snapshot => ({
    protocolVersion: PROTOCOL_VERSION,
    product: "桌边小崽",
    stage: "foundation",
    service: { status: "ready" },
    platform: platformCapabilities(process.platform, process.env),
    runtime: runtime.snapshot(),
    ...(player ? { player: player.snapshot() } : {}),
  });
  const empty = { type: "object", additionalProperties: false } as const;
  app.get("/v1/snapshot", { schema: { querystring: empty } }, async () =>
    snapshot(),
  );
  app.post(
    "/v1/runtime/probe",
    { schema: { querystring: empty, body: empty } },
    async () => {
      const status = await runtime.probe();
      return { ...snapshot(), runtime: status } satisfies Snapshot;
    },
  );
  for (const action of ["start", "stop"] as const) {
    app.post(`/v1/player/${action}`, { schema: { querystring: empty, body: empty } }, async (_request, reply) => {
      if (!player) throw new Error("player_unconfigured");
      if (action === "start" && workspace && !workspace.canStartOwnedPlayer())
        return reply.code(409).send({ error: "linkage_paused" });
      const status = await player[action]();
      return { ...snapshot(), player: status } satisfies Snapshot;
    });
  }
  registerPetRoutes(app, workspace);
  app.addHook("preClose", async () => {
    // Schedule each closer independently: a synchronous throw or rejection must not
    // interrupt another owner draining writes / releasing its lease before process.exit.
    const results = await Promise.allSettled([
      () => runtime.close(), () => player?.close(), () => workspace?.close(),
    ].map(close => Promise.resolve().then(close)));
    if (results.some(result => result.status === "rejected")) throw new Error("service_cleanup_failed");
  });
  return app;
}
