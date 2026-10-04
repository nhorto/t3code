import {
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityPublishProofInvalidReason,
  RelayHeldAgentMessagePublishProofPayload,
  type RelayAgentActivityPublishRequest,
  type RelayHeldAgentMessagePublishRequest,
} from "@t3tools/contracts/relay";
import {
  decodeRelayJwt,
  normalizeRelayIssuer,
  RELAY_ACTIVITY_PUBLISH_TYP,
  RELAY_HELD_MESSAGE_PUBLISH_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";

export class EnvironmentPublishSignatureExpired extends Schema.TaggedError<EnvironmentPublishSignatureExpired>()(
  "EnvironmentPublishSignatureExpired",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' publish signature for thread '${this.threadId}' expired at ${this.expiresAt}`;
  }
}

export class EnvironmentPublishSignatureInvalid extends Schema.TaggedError<EnvironmentPublishSignatureInvalid>()(
  "EnvironmentPublishSignatureInvalid",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    reason: RelayAgentActivityPublishProofInvalidReason,
    stage: Schema.Literals([
      "decode_token",
      "verify_proof",
      "validate_claims",
      "validate_expiration",
      "generate_replay_thumbprint",
      "consume_nonce",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' publish signature for thread '${this.threadId}' is invalid during ${this.stage}: ${this.reason}`;
  }
}

export class EnvironmentPublishPublicKeyMissing extends Schema.TaggedError<EnvironmentPublishPublicKeyMissing>()(
  "EnvironmentPublishPublicKeyMissing",
  {
    environmentId: Schema.String,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' has no publish public key`;
  }
}

export type EnvironmentPublishSignatureError =
  | EnvironmentPublishSignatureExpired
  | EnvironmentPublishSignatureInvalid
  | EnvironmentPublishPublicKeyMissing
  | DpopProofs.DpopProofReplayPersistenceError;

export class EnvironmentPublishSignatures extends Context.Service<
  EnvironmentPublishSignatures,
  {
    readonly verify: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
      readonly request: RelayAgentActivityPublishRequest;
    }) => Effect.Effect<void, EnvironmentPublishSignatureError>;
    /** The same checks for a held agent message alert, under its own JWT type. */
    readonly verifyHeldAgentMessage: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
      readonly request: RelayHeldAgentMessagePublishRequest;
    }) => Effect.Effect<void, EnvironmentPublishSignatureError>;
  }
>()("t3code-relay/environments/EnvironmentPublishSignatures") {}

const decodeProof = Schema.decodeUnknownEffect(RelayAgentActivityPublishProofPayload);
const decodeHeldMessageProof = Schema.decodeUnknownEffect(RelayHeldAgentMessagePublishProofPayload);

function environmentPublishReplayThumbprintData(input: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) {
  return new TextEncoder().encode(
    stableStringify({
      environmentId: input.environmentId,
      environmentPublicKey: input.environmentPublicKey,
    }),
  );
}

const formatEnvironmentPublishReplayThumbprint = (digest: Uint8Array) =>
  `env-publish:${Encoding.encodeBase64Url(digest)}`;

const make = Effect.gen(function* () {
  const proofReplay = yield* DpopProofs.DpopProofReplay;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;

  /**
   * Verifies an environment-signed publish proof: signature, type, issuer and
   * audience, that its claims sign exactly what was sent, and that it is used once.
   */
  const verifyProof = Effect.fn("relay.environment_publish_signatures.verify")(function* <
    P extends {
      readonly environmentId: string;
      readonly threadId: string;
      readonly sub: string;
      readonly jti: string;
      readonly iat: number;
      readonly exp: number;
    },
  >(input: {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
    readonly threadId: string;
    readonly proof: string;
    readonly typ: string;
    readonly decode: (payload: unknown) => Effect.Effect<P, unknown>;
    /** Whether the proof signs exactly the published content. */
    readonly signsRequest: (proof: P) => boolean;
  }) {
    yield* Effect.annotateCurrentSpan({
      "relay.environment_id": input.environmentId,
      "relay.thread_id": input.threadId,
    });
    const now = yield* DateTime.now;
    const decoded = yield* Effect.try({
      try: () => decodeRelayJwt(input.proof),
      catch: (cause) =>
        new EnvironmentPublishSignatureInvalid({
          environmentId: input.environmentId,
          threadId: input.threadId,
          reason: "invalid_signature_or_payload",
          stage: "decode_token",
          cause,
        }),
    });
    if (
      typeof decoded.exp === "number" &&
      decoded.exp <= Math.floor(now.epochMilliseconds / 1_000)
    ) {
      return yield* new EnvironmentPublishSignatureExpired({
        environmentId: input.environmentId,
        threadId: input.threadId,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(decoded.exp * 1_000)),
      });
    }
    const proof = yield* verifyRelayJwt({
      publicKey: input.environmentPublicKey,
      token: input.proof,
      typ: input.typ,
      issuer: `t3-env:${input.environmentId}`,
      audience: normalizeRelayIssuer(config.relayIssuer),
      nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
    }).pipe(
      Effect.flatMap(input.decode),
      Effect.mapError(
        (cause) =>
          new EnvironmentPublishSignatureInvalid({
            environmentId: input.environmentId,
            threadId: input.threadId,
            reason: "invalid_signature_or_payload",
            stage: "verify_proof",
            cause,
          }),
      ),
    );
    if (
      proof.environmentId !== input.environmentId ||
      proof.threadId !== input.threadId ||
      proof.sub !== input.environmentId ||
      !input.signsRequest(proof)
    ) {
      return yield* new EnvironmentPublishSignatureInvalid({
        environmentId: input.environmentId,
        threadId: input.threadId,
        reason: "invalid_signature_or_payload",
        stage: "validate_claims",
      });
    }
    const expiresAt = DateTime.make(proof.exp * 1_000);
    if (expiresAt._tag === "None") {
      return yield* new EnvironmentPublishSignatureInvalid({
        environmentId: input.environmentId,
        threadId: input.threadId,
        reason: "invalid_signature_or_payload",
        stage: "validate_expiration",
      });
    }
    const thumbprint = yield* crypto
      .digest(
        "SHA-256",
        environmentPublishReplayThumbprintData({
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
        }),
      )
      .pipe(
        Effect.map(formatEnvironmentPublishReplayThumbprint),
        Effect.mapError(
          (cause) =>
            new EnvironmentPublishSignatureInvalid({
              environmentId: input.environmentId,
              threadId: input.threadId,
              reason: "invalid_signature_or_payload",
              stage: "generate_replay_thumbprint",
              cause,
            }),
        ),
      );
    const consumedNonce = yield* proofReplay.consume({
      thumbprint,
      jti: proof.jti,
      iat: proof.iat,
      expiresAt: expiresAt.value,
    });
    if (!consumedNonce) {
      return yield* new EnvironmentPublishSignatureInvalid({
        environmentId: input.environmentId,
        threadId: input.threadId,
        reason: "replayed_nonce",
        stage: "consume_nonce",
      });
    }
  });

  return EnvironmentPublishSignatures.of({
    verify: (input) =>
      verifyProof({
        environmentId: input.environmentId,
        environmentPublicKey: input.environmentPublicKey,
        threadId: input.threadId,
        proof: input.request.proof,
        typ: RELAY_ACTIVITY_PUBLISH_TYP,
        decode: decodeProof,
        signsRequest: (proof) =>
          stableStringify(proof.state) === stableStringify(input.request.state) &&
          (input.request.state === null ||
            (input.request.state.environmentId === input.environmentId &&
              input.request.state.threadId === input.threadId)),
      }),
    verifyHeldAgentMessage: (input) =>
      verifyProof({
        environmentId: input.environmentId,
        environmentPublicKey: input.environmentPublicKey,
        threadId: input.threadId,
        proof: input.request.proof,
        typ: RELAY_HELD_MESSAGE_PUBLISH_TYP,
        decode: decodeHeldMessageProof,
        signsRequest: (proof) =>
          stableStringify(proof.notification) === stableStringify(input.request.notification) &&
          input.request.notification.environmentId === input.environmentId &&
          input.request.notification.threadId === input.threadId,
      }),
  });
});

export const layer = Layer.effect(EnvironmentPublishSignatures, make);
