/**
 * The fleet link: this environment (a spoke) holds one long-lived,
 * backlog-only session on another environment (the hub) and calls the hub's
 * backlog RPCs for its agents. Clients never use this; they connect to every
 * environment themselves.
 *
 * The connection is opened on first use and reopened after it drops. While the
 * hub is unreachable, calls fail at once with an `unavailable` BacklogError
 * instead of each waiting on a dead socket; a new attempt is allowed after a
 * backoff of up to a minute.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AgentMessageError,
  AuthAccessTokenType,
  AuthBacklogLinkScopes,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  BacklogError,
  BacklogHubRpcGroup,
  EnvironmentHttpApi,
  EnvironmentId,
  IsoDateTime,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  TrimmedNonEmptyString,
  WS_METHODS,
  type AgentMessageAckInput,
  type AgentMessageEnvelope,
  type AgentMessageInboxEvent,
  type AgentMessageRelayReceipt,
  type AgentMessagesSubscribeInboxInput,
  type BacklogHubLinkStatus,
  type BacklogLinkHubInput,
  type BacklogRenewClaimsInput,
  type BacklogUnavailableReason,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import type { BacklogHome } from "./BacklogHome.ts";
import { isThreadHoldingClaims } from "./BacklogService.ts";

const HUB_LINK_SECRET = "backlog-hub-link";
const REQUEST_TIMEOUT = "10 seconds";
const SOCKET_OPEN_TIMEOUT = "5 seconds";
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** Well inside the 15-minute lease, so one missed renewal costs nothing. */
export const HUB_LEASE_RENEW_INTERVAL = "5 minutes";

const StoredHubLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  accessToken: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
type StoredHubLink = typeof StoredHubLink.Type;
const StoredHubLinkJson = Schema.fromJsonString(StoredHubLink);
const encodeStoredHubLink = Schema.encodeSync(StoredHubLinkJson);
const decodeStoredHubLink = Schema.decodeUnknownOption(StoredHubLinkJson);

export interface LinkedHub {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export class BacklogHubClient extends Context.Service<
  BacklogHubClient,
  {
    /** The hub this environment is linked to, if any. */
    readonly linkedHub: Effect.Effect<Option.Option<LinkedHub>>;
    /** The current link, then each change to it. */
    readonly linkedHubChanges: Stream.Stream<Option.Option<LinkedHub>>;
    /** The hub's backlogs. Every call fails with code unavailable when there is no reachable hub. */
    readonly home: BacklogHome;
    readonly renewClaims: (input: BacklogRenewClaimsInput) => Effect.Effect<void, BacklogError>;
    /** Signals each time a connection to the hub opens, including reconnects. */
    readonly connections: () => Stream.Stream<void>;
    /** Link state; when linked, tries to reach the hub so the answer is current. */
    readonly status: () => Effect.Effect<BacklogHubLinkStatus>;
    /** Redeems a pairing URL minted on the hub and replaces any existing link. */
    readonly link: (
      input: BacklogLinkHubInput,
    ) => Effect.Effect<BacklogHubLinkStatus, BacklogError>;
    readonly unlink: () => Effect.Effect<BacklogHubLinkStatus>;
    /** The hub's agent message relay; see AgentMessageRelay. */
    readonly relayAgentMessage: (
      envelope: AgentMessageEnvelope,
    ) => Effect.Effect<AgentMessageRelayReceipt, AgentMessageError | BacklogError>;
    readonly ackAgentMessage: (
      input: AgentMessageAckInput,
    ) => Effect.Effect<void, AgentMessageError | BacklogError>;
    /** Ends when the connection drops or the link changes; the caller reopens it. */
    readonly agentMessageInbox: (
      input: AgentMessagesSubscribeInboxInput,
    ) => Stream.Stream<AgentMessageInboxEvent, BacklogError>;
  }
>()("t3/backlog/BacklogHubClient") {}

export const unavailable = (reason: BacklogUnavailableReason, message: string) =>
  new BacklogError({ code: "unavailable", reason, message });

const invalid = (message: string) => new BacklogError({ code: "invalid", message });

const protocolMismatch = (label: string) =>
  unavailable(
    "protocol_mismatch",
    `${label} runs a different T3 Code version that cannot answer this. Update both machines.`,
  );

const isBacklogError = Schema.is(BacklogError);
const isAgentMessageError = Schema.is(AgentMessageError);

const tagOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "";

const reasonOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "reason" in error ? String(error.reason) : "";

const makeHubRpcClient = RpcClient.make(BacklogHubRpcGroup);
type HubRpcClient =
  typeof makeHubRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

interface Connection {
  readonly client: HubRpcClient;
  readonly scope: Scope.Closeable;
  /** Set when the socket closes; the next call opens a new connection. */
  readonly lost: Ref.Ref<boolean>;
  /** Completes when the connection is lost or closed, ending streams opened on it. */
  readonly closed: Deferred.Deferred<void>;
}

interface ConnectionState {
  readonly connection: Connection | null;
  readonly error: { readonly reason: BacklogUnavailableReason; readonly message: string } | null;
  /** While the last attempt failed, calls before this instant fail without dialing. */
  readonly retryAtMs: number;
  readonly backoffMs: number;
}

const IDLE: ConnectionState = { connection: null, error: null, retryAtMs: 0, backoffMs: 0 };

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;

  const stored = yield* secrets.get(HUB_LINK_SECRET).pipe(
    Effect.map(Option.flatMap((bytes) => decodeStoredHubLink(new TextDecoder().decode(bytes)))),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the backlog hub link", { cause }).pipe(
        Effect.as(Option.none<StoredHubLink>()),
      ),
    ),
  );
  const linkRef = yield* Ref.make(stored);
  const toLinkedHub = Option.map((link: StoredHubLink): LinkedHub => ({
    environmentId: link.environmentId,
    label: link.label,
  }));
  const linkedHubRef = yield* SubscriptionRef.make(toLinkedHub(stored));
  const stateRef = yield* Ref.make(IDLE);
  // One dial at a time; calls that arrive meanwhile share its result.
  const dialLock = yield* Semaphore.make(1);
  /** One signal per connection opened to the hub. */
  const connected = yield* PubSub.unbounded<void>();

  const apiFor = (httpBaseUrl: string) =>
    HttpApiClient.make(EnvironmentHttpApi, { baseUrl: httpBaseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const httpFailure = (label: string) => (error: unknown) => {
    if (isBacklogError(error)) return error;
    if (tagOf(error) === "EnvironmentAuthInvalidError") {
      return unavailable(
        "unauthorized",
        `${label} no longer accepts this machine's backlog link. Link it again from Settings → Backlog.`,
      );
    }
    return unavailable("unreachable", `${label} is unreachable.`);
  };

  const closeConnection = (connection: Connection | null) =>
    connection === null
      ? Effect.void
      : Deferred.succeed(connection.closed, undefined).pipe(
          Effect.andThen(Scope.close(connection.scope, Exit.void)),
        );

  /** Whether the hub refuses this build's orchestration protocol (HTTP 426 on /ws). */
  const rejectsProtocol = (link: StoredHubLink) =>
    Effect.gen(function* () {
      const url = new URL("/ws", link.httpBaseUrl);
      url.searchParams.set(
        ORCHESTRATION_PROTOCOL_QUERY_PARAM,
        String(ORCHESTRATION_PROTOCOL_VERSION),
      );
      const response = yield* httpClient.get(url);
      return response.status === 426;
    }).pipe(
      Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.succeed(false) }),
      Effect.orElseSucceed(() => false),
    );

  const dial = (link: StoredHubLink) =>
    Effect.gen(function* () {
      const api = yield* apiFor(link.httpBaseUrl);
      const ticket = yield* api.auth
        .webSocketTicket({ headers: { authorization: `Bearer ${link.accessToken}` } })
        .pipe(Effect.mapError(httpFailure(link.label)));
      const url = new URL(link.wsBaseUrl);
      url.pathname = "/ws";
      url.search = "";
      url.searchParams.set("wsTicket", ticket.ticket);
      url.searchParams.set(
        ORCHESTRATION_PROTOCOL_QUERY_PARAM,
        String(ORCHESTRATION_PROTOCOL_VERSION),
      );

      const scope = yield* Scope.make();
      return yield* Effect.gen(function* () {
        const opened = yield* Deferred.make<void, BacklogError>();
        const lost = yield* Ref.make(false);
        const closed = yield* Deferred.make<void>();
        const hooks = RpcClient.ConnectionHooks.of({
          onConnect: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
          onDisconnect: Ref.set(lost, true).pipe(
            Effect.andThen(Deferred.succeed(closed, undefined)),
            Effect.andThen(
              Deferred.fail(
                opened,
                unavailable("unreachable", `Could not open a connection to ${link.label}.`),
              ),
            ),
            Effect.asVoid,
          ),
        });
        const protocol = Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({
            retryTransientErrors: false,
            retryPolicy: Schedule.recurs(0),
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Socket.layerWebSocket(url.toString(), { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(
                Layer.provide(NodeSocket.layerWebSocketConstructor),
              ),
              RpcSerialization.layerJson,
              Layer.succeed(RpcClient.ConnectionHooks, hooks),
            ),
          ),
        );
        const context = yield* Layer.buildWithScope(protocol, scope);
        const client = yield* makeHubRpcClient.pipe(Effect.provide(context), Scope.provide(scope));
        yield* Deferred.await(opened).pipe(
          // The hub answers an incompatible protocol with HTTP 426 instead of upgrading.
          Effect.catch((error) =>
            rejectsProtocol(link).pipe(
              Effect.flatMap((rejected) =>
                Effect.fail(rejected ? protocolMismatch(link.label) : error),
              ),
            ),
          ),
        );
        return { client, scope, lost, closed } satisfies Connection;
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    }).pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(unavailable("unreachable", `${link.label} did not answer in time.`)),
      }),
    );

  /** The open connection, dialing when there is none and the backoff allows. */
  const acquire = dialLock.withPermits(1)(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* (): Effect.fn.Return<Connection, BacklogError> {
        const link = yield* Ref.get(linkRef);
        if (Option.isNone(link)) {
          return yield* unavailable("not_linked", "This machine is not linked to a backlog hub.");
        }
        const state = yield* Ref.get(stateRef);
        if (state.connection !== null && !(yield* Ref.get(state.connection.lost))) {
          return state.connection;
        }
        yield* closeConnection(state.connection);
        const nowMs = (yield* DateTime.now).epochMilliseconds;
        if (state.error !== null && nowMs < state.retryAtMs) {
          return yield* unavailable(state.error.reason, state.error.message);
        }
        // Only the dial may be interrupted; a connection it opened is always kept
        // in state, so it is closed later rather than leaked with its pinger.
        const dialed = yield* Effect.exit(restore(dial(link.value)));
        if (Exit.isSuccess(dialed)) {
          yield* Ref.set(stateRef, { ...IDLE, connection: dialed.value });
          yield* PubSub.publish(connected, undefined);
          return dialed.value;
        }
        if (Cause.hasInterrupts(dialed.cause)) return yield* Effect.failCause(dialed.cause);
        const error = Exit.findErrorOption(dialed).pipe(
          Option.getOrElse(() => unavailable("unreachable", `${link.value.label} is unreachable.`)),
        );
        const backoffMs = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, state.backoffMs * 2));
        yield* Ref.set(stateRef, {
          connection: null,
          error: { reason: error.reason ?? "unreachable", message: error.message },
          retryAtMs: nowMs + backoffMs,
          backoffMs,
        });
        return yield* error;
      }),
    ),
  );

  /** Runs one RPC on the hub; anything but the hub's own BacklogError becomes unavailable. */
  const call = <A, E>(
    run: (client: HubRpcClient) => Effect.Effect<A, E>,
  ): Effect.Effect<A, BacklogError> =>
    Effect.gen(function* () {
      const connection = yield* acquire;
      const label = Option.match(yield* Ref.get(linkRef), {
        onNone: () => "The backlog hub",
        onSome: (link) => link.label,
      });
      const markLost = (error: BacklogError) =>
        Ref.set(connection.lost, true).pipe(
          Effect.andThen(Deferred.succeed(connection.closed, undefined)),
          Effect.andThen(
            Ref.update(stateRef, (state) => ({
              ...state,
              error: { reason: error.reason ?? "unreachable", message: error.message },
            })),
          ),
          Effect.andThen(Effect.fail(error)),
        );
      return yield* run(connection.client).pipe(
        // A hub on another build answers an RPC it does not know, or with a shape
        // this build cannot decode, as a defect. The connection itself is fine.
        Effect.catchDefect(() => Effect.fail(protocolMismatch(label))),
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () =>
            markLost(unavailable("unreachable", `${label} did not answer within 10 seconds.`)),
        }),
        Effect.catch((error) => {
          if (isBacklogError(error)) return Effect.fail(error);
          if (tagOf(error) === "EnvironmentAuthorizationError") {
            return Effect.fail(
              unavailable(
                "unauthorized",
                `${label} refused the backlog link's permissions. Link it again from Settings → Backlog.`,
              ),
            );
          }
          return markLost(unavailable("unreachable", `Lost the connection to ${label}.`));
        }),
      );
    });

  const home: BacklogHome = {
    listBacklogs: () => call((client) => client[WS_METHODS.backlogListBacklogs]({})),
    listIssues: (input) => call((client) => client[WS_METHODS.backlogListIssues](input)),
    resolveIssue: (ref) => call((client) => client[WS_METHODS.backlogResolveIssue]({ ref })),
    getIssue: (input) => call((client) => client[WS_METHODS.backlogGetIssue](input)),
    createIssue: (input, actor) =>
      call((client) => client[WS_METHODS.backlogCreateIssue]({ ...input, actor })),
    createChildren: (input, actor) =>
      call((client) => client[WS_METHODS.backlogCreateChildren]({ ...input, actor })),
    updateIssue: (input, actor) =>
      call((client) => client[WS_METHODS.backlogUpdateIssue]({ ...input, actor })),
    comment: (input, actor) =>
      call((client) => client[WS_METHODS.backlogComment]({ ...input, actor })),
    claim: (input, actor) => call((client) => client[WS_METHODS.backlogClaim]({ ...input, actor })),
    claimNext: (input, actor) =>
      call((client) => client[WS_METHODS.backlogClaimNext]({ ...input, actor })),
    release: (input, actor) =>
      call((client) => client[WS_METHODS.backlogRelease]({ ...input, actor })),
    linkPullRequest: (input, actor) =>
      call((client) => client[WS_METHODS.backlogLinkPullRequest]({ ...input, actor })),
  };

  /** The hub's own AgentMessageError is an answer, not a lost connection. */
  const callRelay = <A, E>(
    run: (client: HubRpcClient) => Effect.Effect<A, E>,
  ): Effect.Effect<A, AgentMessageError | BacklogError> =>
    call((client) =>
      run(client).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catchIf(isAgentMessageError, (error) =>
          Effect.succeed({ ok: false as const, error }),
        ),
      ),
    ).pipe(
      Effect.flatMap((answer) =>
        answer.ok ? Effect.succeed(answer.value) : Effect.fail(answer.error),
      ),
    );

  const relayAgentMessage: BacklogHubClient["Service"]["relayAgentMessage"] = (envelope) =>
    callRelay((client) => client[WS_METHODS.agentMessagesRelay](envelope));
  const ackAgentMessage: BacklogHubClient["Service"]["ackAgentMessage"] = (input) =>
    callRelay((client) => client[WS_METHODS.agentMessagesAck](input));
  const agentMessageInbox: BacklogHubClient["Service"]["agentMessageInbox"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* acquire;
        const label = Option.match(yield* Ref.get(linkRef), {
          onNone: () => "The backlog hub",
          onSome: (link) => link.label,
        });
        return connection.client[WS_METHODS.agentMessagesSubscribeInbox](input).pipe(
          Stream.interruptWhen(Deferred.await(connection.closed)),
          Stream.catchDefect(() => Stream.fail(protocolMismatch(label))),
          Stream.catch((error) =>
            isBacklogError(error)
              ? Stream.fail(error)
              : Stream.fromEffect(
                  Ref.set(connection.lost, true).pipe(
                    Effect.andThen(Deferred.succeed(connection.closed, undefined)),
                    Effect.andThen(
                      Effect.fail(unavailable("unreachable", `Lost the connection to ${label}.`)),
                    ),
                  ),
                ),
          ),
        );
      }),
    );

  const status: BacklogHubClient["Service"]["status"] = () =>
    Effect.gen(function* () {
      const link = yield* Ref.get(linkRef);
      if (Option.isNone(link)) return { state: "not_linked", hub: null, error: null };
      // Someone is looking: try now rather than after the backoff.
      yield* Ref.update(stateRef, (state) => ({ ...state, retryAtMs: 0 }));
      yield* Effect.ignore(acquire);
      const state = yield* Ref.get(stateRef);
      const connected = state.connection !== null && !(yield* Ref.get(state.connection.lost));
      return {
        state: connected ? "connected" : "disconnected",
        hub: {
          environmentId: link.value.environmentId,
          label: link.value.label,
          httpBaseUrl: link.value.httpBaseUrl,
          linkedAt: link.value.linkedAt,
          expiresAt: link.value.expiresAt,
        },
        error: connected
          ? null
          : (state.error ?? {
              reason: "unreachable",
              message: `${link.value.label} is unreachable.`,
            }),
      } satisfies BacklogHubLinkStatus;
    });

  const replaceLink = (next: Option.Option<StoredHubLink>) =>
    dialLock.withPermits(1)(
      Effect.gen(function* () {
        yield* closeConnection((yield* Ref.get(stateRef)).connection);
        yield* Ref.set(stateRef, IDLE);
        yield* Ref.set(linkRef, next);
        yield* SubscriptionRef.set(linkedHubRef, toLinkedHub(next));
      }),
    );

  const link: BacklogHubClient["Service"]["link"] = ({ pairingUrl }) =>
    Effect.gen(function* () {
      const target = yield* Effect.try({
        try: () => resolveRemotePairingTarget({ pairingUrl }),
        catch: () =>
          invalid("That is not a pairing URL. Mint one on the hub under Settings → Connections."),
      });
      const host = new URL(target.httpBaseUrl).host;
      const api = yield* apiFor(target.httpBaseUrl);
      const timeout = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: REQUEST_TIMEOUT,
            orElse: () =>
              Effect.fail(unavailable("unreachable", `${host} did not answer in time.`)),
          }),
        );
      const descriptor = yield* timeout(api.metadata.descriptor()).pipe(
        Effect.mapError(httpFailure(host)),
      );
      const self = yield* serverEnvironment.getDescriptor;
      if (descriptor.environmentId === self.environmentId) {
        return yield* invalid(
          "That pairing URL is for this machine. Mint it on the hub you want to link to.",
        );
      }
      const token = yield* timeout(
        api.auth.token({
          headers: {},
          payload: {
            grant_type: AuthTokenExchangeGrantType,
            subject_token: target.credential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            scope: encodeOAuthScope(AuthBacklogLinkScopes),
            client_label: `${self.label} (backlog link)`,
            client_device_type: "bot",
          },
        }),
      ).pipe(
        Effect.mapError((error) => {
          if (isBacklogError(error)) return error;
          if (
            tagOf(error) === "EnvironmentRequestInvalidError" &&
            reasonOf(error) === "invalid_scope"
          ) {
            return unavailable(
              "protocol_mismatch",
              `${descriptor.label} runs a T3 Code without backlog links. Update it first.`,
            );
          }
          if (tagOf(error) === "EnvironmentAuthInvalidError") {
            return invalid("That pairing URL has expired or was already used. Mint a new one.");
          }
          if (tagOf(error) === "EnvironmentRequestInvalidError") {
            return invalid(
              "The pairing URL does not grant backlog access. Mint one with the Backlog link permissions.",
            );
          }
          return unavailable("unreachable", `${descriptor.label} is unreachable.`);
        }),
      );
      const now = yield* DateTime.now;
      const next: StoredHubLink = {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: target.httpBaseUrl,
        wsBaseUrl: target.wsBaseUrl,
        accessToken: token.access_token,
        linkedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { seconds: token.expires_in })),
      };
      yield* secrets.set(HUB_LINK_SECRET, new TextEncoder().encode(encodeStoredHubLink(next))).pipe(
        Effect.mapError(
          () =>
            new BacklogError({
              code: "unavailable",
              message: "Could not save the hub link on this machine. Check its state directory.",
            }),
        ),
      );
      yield* replaceLink(Option.some(next));
      return yield* status();
    });

  const unlink: BacklogHubClient["Service"]["unlink"] = () =>
    Effect.gen(function* () {
      yield* secrets.remove(HUB_LINK_SECRET).pipe(Effect.orDie);
      yield* replaceLink(Option.none());
      return yield* status();
    });

  yield* Effect.addFinalizer(() =>
    Ref.get(stateRef).pipe(Effect.flatMap((state) => closeConnection(state.connection))),
  );

  return BacklogHubClient.of({
    linkedHub: Ref.get(linkRef).pipe(Effect.map(toLinkedHub)),
    linkedHubChanges: SubscriptionRef.changes(linkedHubRef),
    home,
    renewClaims: (input) => call((client) => client[WS_METHODS.backlogRenewClaims](input)),
    connections: () => Stream.fromPubSub(connected),
    status,
    link,
    unlink,
    relayAgentMessage,
    ackAgentMessage,
    agentMessageInbox,
  });
});

export const layer = Layer.effect(BacklogHubClient, make);

/**
 * Keeps this environment's claims on the hub alive: every few minutes, renews
 * the leases held by its threads that still hold claims by the same rule the
 * hub applies to its own threads (isThreadHoldingClaims). A thread that stops
 * qualifying loses its claim when the lease runs out.
 */
export const renewHubLeasesForever = Effect.gen(function* () {
  const hub = yield* BacklogHubClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const renewOnce = Effect.gen(function* () {
    if (Option.isNone(yield* hub.linkedHub)) return;
    const { threads: shells } = yield* threads.getShellSnapshot({ location: "active" });
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    const threadIds = shells
      .filter((shell) => isThreadHoldingClaims(shell, nowMs))
      .map((shell) => shell.id);
    if (threadIds.length === 0) return;
    yield* hub.renewClaims({ environmentId, threadIds });
  });
  const renew = renewOnce.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Backlog hub lease renewal failed", { cause })),
  );
  // After a reconnect, leases that ran low while the hub was away are renewed at once.
  yield* Stream.runForEach(hub.connections(), () => renew).pipe(Effect.forkChild);
  return yield* Effect.sleep(HUB_LEASE_RENEW_INTERVAL).pipe(Effect.andThen(renew), Effect.forever);
});

export const renewalLayer = Layer.effectDiscard(forkParked(renewHubLeasesForever));
