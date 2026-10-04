import { describe, expect, it } from "@effect/vitest";

import {
  AuthAccessWriteScope,
  AuthBacklogReadScope,
  AuthBacklogWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
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
