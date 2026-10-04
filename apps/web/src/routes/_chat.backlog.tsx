import type { BacklogIssueId, EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BacklogPage, type BacklogPageSearch } from "../components/backlog/BacklogPage";
import { parseBacklogScope } from "../components/backlog/backlog.logic";

export const Route = createFileRoute("/_chat/backlog")({
  validateSearch: (raw: Record<string, unknown>): BacklogPageSearch => ({
    ...(typeof raw.scope === "string" && raw.scope && raw.scope !== "all"
      ? { scope: raw.scope.slice(0, 500) }
      : {}),
    ...(typeof raw.issueEnvironmentId === "string" &&
    raw.issueEnvironmentId &&
    typeof raw.issueId === "string" &&
    raw.issueId
      ? {
          issueEnvironmentId: raw.issueEnvironmentId as EnvironmentId,
          issueId: raw.issueId as BacklogIssueId,
        }
      : {}),
    ...(raw.view === "graph" ? { view: "graph" as const } : {}),
    ...(raw.messages === true || raw.messages === "true" || raw.messages === 1
      ? { messages: true as const }
      : {}),
  }),
  component: BacklogRouteView,
});

function BacklogRouteView() {
  const search = Route.useSearch();
  return <BacklogPage search={search} scope={parseBacklogScope(search.scope)} />;
}
