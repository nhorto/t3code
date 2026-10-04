import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  AuthAccessWriteScope,
  AuthBacklogReadScope,
  AuthBacklogWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPairingLink,
  AuthStandardClientScopes,
  hasAuthScope,
} from "./auth.ts";

describe("hasAuthScope", () => {
  it("lets sessions issued before the backlog scopes keep backlog access", () => {
    expect(hasAuthScope(AuthStandardClientScopes, AuthBacklogReadScope)).toBe(true);
    expect(hasAuthScope(AuthStandardClientScopes, AuthBacklogWriteScope)).toBe(true);
    expect(hasAuthScope([AuthOrchestrationReadScope], AuthBacklogReadScope)).toBe(true);
    expect(hasAuthScope([AuthOrchestrationReadScope], AuthBacklogWriteScope)).toBe(false);
  });

  it("keeps a backlog-only link session out of everything else", () => {
    const link = new Set([AuthBacklogReadScope, AuthBacklogWriteScope] as const);
    expect(hasAuthScope(link, AuthBacklogWriteScope)).toBe(true);
    expect(hasAuthScope(link, AuthOrchestrationReadScope)).toBe(false);
    expect(hasAuthScope(link, AuthOrchestrationOperateScope)).toBe(false);
    expect(hasAuthScope(link, AuthAccessWriteScope)).toBe(false);
  });
});

describe("listed scopes", () => {
  const link = {
    id: "link-1",
    subject: "one-time-token",
    createdAt: DateTime.makeUnsafe(0),
    expiresAt: DateTime.makeUnsafe(60_000),
    scopes: [AuthOrchestrationReadScope, AuthBacklogReadScope, AuthBacklogWriteScope],
  } as const;
  // The codec the RPC and HTTP layers put on the wire.
  const Json = Schema.toCodecJson(AuthPairingLink);
  const encode = (value: typeof link) => JSON.stringify(Schema.encodeSync(Json)(value));
  const decode = (json: string) => Schema.decodeUnknownSync(Json)(JSON.parse(json));

  it("keeps scopes released clients do not know out of the field they decode strictly", () => {
    const wire = JSON.parse(encode(link));
    expect(wire.scopes).toEqual([AuthOrchestrationReadScope]);
    expect(wire.additionalScopes).toEqual([AuthBacklogReadScope, AuthBacklogWriteScope]);
    // What a client from before the backlog scopes decodes.
    const Released = Schema.Struct({
      scopes: Schema.Array(Schema.Literals(["orchestration:read", "orchestration:operate"])),
    });
    expect(Schema.decodeUnknownSync(Released)(wire).scopes).toEqual([AuthOrchestrationReadScope]);
    expect(decode(encode(link)).scopes).toEqual(link.scopes);
  });

  it("drops scopes from a newer server instead of failing", () => {
    const wire = {
      ...JSON.parse(encode(link)),
      additionalScopes: ["backlog:read", "future:scope"],
    };
    expect(decode(JSON.stringify(wire)).scopes).toEqual([
      AuthOrchestrationReadScope,
      AuthBacklogReadScope,
    ]);
  });
});
