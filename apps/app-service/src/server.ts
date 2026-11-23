import Fastify from "fastify";
import type { TextChatRuntime } from "./agent/text-chat-runtime.ts";
import type { ChatHistory } from './chat-history.ts';
import { registerOnlineChat } from "./online-chat.ts";
import { registerCharacterRoutes } from "./characters/routes.ts";
import type { CharacterRepository } from "./characters/repository.ts";
import { registerSpeechRoutes } from "./speech/routes.ts";
import type { BubbleSpeech } from "./speech/bubble-speech.ts";
import { registerModelManagement } from "./models/management-routes.ts";
import type { ModelManagement } from "./models/management.ts";
import { registerPetRoutes } from "./pet-routes.ts";
import type { PetWorkspace } from "./pet-workspace.ts";
import { timingSafeEqual } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type RuntimeController,
  type Snapshot,
} from "../../../packages/contracts/src/index.ts";
import { platformCapabilities } from "./platform.ts";

export function createService({
  token,
  runtime,
  workspace,
  models,
  speech,
  characters,
  chatRuntime,
  chatHistory,
}: {
  token: string;
  runtime: RuntimeController;
  workspace?: PetWorkspace;
  models?: ModelManagement;
  speech?: BubbleSpeech;
  characters?: CharacterRepository;
  chatRuntime?: TextChatRuntime;
  chatHistory?: ChatHistory;
}) {
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error("Invalid session credential");
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    // Once preClose drains owned operations, retire all of this bridge's
    // sockets, including replacement pool connections with no HTTP request yet.
    forceCloseConnections: true,
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
  registerPetRoutes(app, workspace);
  registerModelManagement(app, models);
  const chat = registerOnlineChat(app, models, workspace, characters, chatRuntime, chatHistory);
  registerSpeechRoutes(app, speech);
  registerCharacterRoutes(app, workspace, characters);
  app.addHook("preClose", async () => {
    const chatCleanup = await Promise.allSettled([chat?.close()]);
    // Schedule each closer independently: a synchronous throw or rejection must not
    // interrupt another owner draining writes / releasing its lease before process.exit.
    const results = await Promise.allSettled([
      () => runtime.close(), () => workspace?.close(), () => models?.close(), () => speech?.close(), () => characters?.close(),
    ].map(close => Promise.resolve().then(close)));
    if ([...chatCleanup, ...results].some(result => result.status === "rejected")) throw new Error("service_cleanup_failed");
  });
  return app;
}
