/**
 * The hub's post office for agent messages between machines. A machine linked
 * to this hub relays a message for a thread elsewhere here; the message waits,
 * addressed to the receiving machine, until that machine's inbox subscription
 * picks it up and acks what became of it. Acks flow back to the sender's inbox.
 * This machine reads its own inbox in-process, so it delivers to its threads,
 * and learns the fate of the messages it sent, the same way a linked one does.
 *
 * Messages for a machine that stays offline fail after a day instead of
 * waiting forever, so the sender always hears back.
 */
import {
  AgentMessageEnvelope,
  AgentMessageError,
  type AgentMessageAckInput,
  type AgentMessageInboxEvent,
  type AgentMessageRelayReceipt,
  type AgentMessagesSubscribeInboxInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";

/** How long a message waits for an offline machine before it is reported undeliverable. */
export const RELAY_UNDELIVERABLE_AFTER_MS = 24 * 60 * 60_000;
/** How often waiting messages are checked against that limit. */
export const RELAY_SWEEP_INTERVAL = "10 minutes";
/** Settled messages are forgotten after this; acks older than this are not replayed. */
const RELAY_RETENTION_MS = 7 * 24 * 60 * 60_000;

export class AgentMessageRelay extends Context.Service<
  AgentMessageRelay,
  {
    /** Stores a message for its receiving machine. Fails when that machine has never connected. */
    readonly relay: (
      envelope: AgentMessageEnvelope,
    ) => Effect.Effect<AgentMessageRelayReceipt, AgentMessageError>;
    /**
     * The machine's waiting messages and the settled status of the ones it
     * sent, then both as they happen. Redelivery is expected: receivers
     * dedupe by message id.
     */
    readonly inbox: (
      input: AgentMessagesSubscribeInboxInput,
    ) => Stream.Stream<AgentMessageInboxEvent, AgentMessageError>;
    /** The receiving machine reports what became of a message. */
    readonly ack: (input: AgentMessageAckInput) => Effect.Effect<void, AgentMessageError>;
  }
>()("t3/agentMessages/AgentMessageRelay") {}

interface RelayRow {
  readonly id: string;
  readonly from_environment_id: string;
  readonly to_environment_id: string;
  readonly envelope: string;
  readonly status: string;
  readonly to_label: string | null;
  readonly delivered_at: string | null;
  readonly error: string | null;
}

/** Hub-side routing: who an event is for. */
type RelayEvent =
  | { readonly to: string; readonly event: AgentMessageInboxEvent }
  | { readonly from: string; readonly event: AgentMessageInboxEvent };

const EnvelopeJson = Schema.fromJsonString(AgentMessageEnvelope);
const encodeEnvelope = Schema.encodeSync(EnvelopeJson);
const decodeEnvelope = Schema.decodeUnknownEffect(EnvelopeJson);

const statusEvent = (row: RelayRow): AgentMessageInboxEvent =>
  ({
    type: "status",
    update: {
      id: row.id,
      status: row.status,
      toLabel: row.to_label ?? "",
      deliveredAt: row.delivered_at,
      error: row.error,
    },
  }) as AgentMessageInboxEvent;

const fail = (code: AgentMessageError["code"], message: string) =>
  Effect.fail(new AgentMessageError({ code, message }));

// Fork-only feature: created idempotently, for the reason given in BacklogService.ts.
const ensureSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_message_relay (
      id TEXT PRIMARY KEY,
      from_environment_id TEXT NOT NULL,
      to_environment_id TEXT NOT NULL,
      envelope TEXT NOT NULL,
      status TEXT NOT NULL,
      to_label TEXT,
      delivered_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS agent_message_relay_to ON agent_message_relay (to_environment_id, status, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS agent_message_relay_from ON agent_message_relay (from_environment_id, updated_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_message_relay_machines (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `;
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const events = yield* PubSub.unbounded<RelayEvent>();
  yield* ensureSchema;

  const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /** The machine's name, or null when it has never subscribed to this hub. */
  const machineLabel = Effect.fn("AgentMessageRelay.machineLabel")(function* (
    environmentId: string,
  ) {
    if (environmentId === localEnvironmentId) {
      return (yield* serverEnvironment.getDescriptor).label;
    }
    const rows = yield* sql<{ label: string }>`
      SELECT label FROM agent_message_relay_machines WHERE environment_id = ${environmentId}
    `;
    return rows[0]?.label ?? null;
  });

  const relay: AgentMessageRelay["Service"]["relay"] = (envelope) =>
    Effect.gen(function* () {
      const machine = yield* machineLabel(envelope.to.environmentId);
      if (machine === null) {
        return yield* fail(
          "remote",
          `Thread ${envelope.to.threadId} is on a machine that is not linked to ${(yield* serverEnvironment.getDescriptor).label}. Link it to this backlog hub under Settings → Backlog.`,
        );
      }
      const now = yield* nowIso;
      const inserted = yield* sql<{ id: string }>`
        INSERT INTO agent_message_relay (
          id, from_environment_id, to_environment_id, envelope, status, created_at, updated_at
        ) VALUES (
          ${envelope.id}, ${envelope.from.environmentId}, ${envelope.to.environmentId},
          ${encodeEnvelope(envelope)}, 'pending', ${now}, ${now}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      if (inserted.length > 0) {
        yield* PubSub.publish(events, {
          to: envelope.to.environmentId,
          event: { type: "message", message: envelope },
        });
      }
      return { id: envelope.id, machine };
    }).pipe(
      Effect.catch((error) =>
        Schema.is(AgentMessageError)(error) ? Effect.fail(error) : Effect.die(error),
      ),
    );

  const inbox: AgentMessageRelay["Service"]["inbox"] = ({ environmentId, label }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        if (environmentId !== localEnvironmentId) {
          yield* sql`
            INSERT INTO agent_message_relay_machines (environment_id, label, last_seen_at)
            VALUES (${environmentId}, ${label}, ${DateTime.formatIso(now)})
            ON CONFLICT (environment_id) DO UPDATE SET
              label = excluded.label, last_seen_at = excluded.last_seen_at
          `;
        }
        // Subscribe before the backlog query so nothing relayed meanwhile is missed.
        const subscription = yield* PubSub.subscribe(events);
        const waiting = yield* sql<RelayRow>`
          SELECT * FROM agent_message_relay
          WHERE to_environment_id = ${environmentId} AND status = 'pending'
          ORDER BY created_at, rowid
        `;
        const settled = yield* sql<RelayRow>`
          SELECT * FROM agent_message_relay
          WHERE from_environment_id = ${environmentId} AND status != 'pending'
          ORDER BY updated_at, rowid
        `;
        const backlog: AgentMessageInboxEvent[] = [];
        for (const row of waiting) {
          backlog.push({ type: "message", message: yield* decodeEnvelope(row.envelope) });
        }
        for (const row of settled) backlog.push(statusEvent(row));
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter((routed) =>
            "to" in routed ? routed.to === environmentId : routed.from === environmentId,
          ),
          Stream.map((routed) => routed.event),
        );
        return Stream.concat(Stream.fromIterable(backlog), live);
      }).pipe(Effect.orDie),
    );

  const ack: AgentMessageRelay["Service"]["ack"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<RelayRow>`
        UPDATE agent_message_relay SET
          status = ${input.status},
          to_label = ${input.toLabel},
          delivered_at = ${input.deliveredAt},
          error = ${input.error},
          updated_at = ${yield* nowIso}
        WHERE id = ${input.id}
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) return yield* fail("not_found", "Message not found.");
      yield* PubSub.publish(events, { from: row.from_environment_id, event: statusEvent(row) });
    }).pipe(
      Effect.catch((error) =>
        Schema.is(AgentMessageError)(error) ? Effect.fail(error) : Effect.die(error),
      ),
    );

  /** Fails messages that waited too long for their machine and forgets old settled ones. */
  const sweep = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const cutoff = DateTime.formatIso(
      DateTime.subtract(now, { milliseconds: RELAY_UNDELIVERABLE_AFTER_MS }),
    );
    const expired = yield* sql<RelayRow>`
      SELECT * FROM agent_message_relay WHERE status = 'pending' AND created_at < ${cutoff}
    `;
    for (const row of expired) {
      const machine = (yield* machineLabel(row.to_environment_id)) ?? "The receiving machine";
      const updated = yield* sql<RelayRow>`
        UPDATE agent_message_relay SET
          status = 'failed',
          error = ${`Undeliverable: ${machine} stayed offline for 24 hours.`},
          updated_at = ${DateTime.formatIso(now)}
        WHERE id = ${row.id} AND status = 'pending'
        RETURNING *
      `;
      if (updated[0] !== undefined) {
        yield* PubSub.publish(events, {
          from: updated[0].from_environment_id,
          event: statusEvent(updated[0]),
        });
      }
    }
    const forget = DateTime.formatIso(DateTime.subtract(now, { milliseconds: RELAY_RETENTION_MS }));
    yield* sql`DELETE FROM agent_message_relay WHERE status != 'pending' AND updated_at < ${forget}`;
  });

  yield* forkParked(
    Effect.sleep(RELAY_SWEEP_INTERVAL).pipe(
      Effect.andThen(
        sweep.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Agent message relay sweep failed", { cause }),
          ),
        ),
      ),
      Effect.forever,
    ),
  );

  return AgentMessageRelay.of({ relay, inbox, ack });
});

export const layer = Layer.effect(AgentMessageRelay, make);
