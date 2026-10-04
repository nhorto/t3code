import { createFileRoute } from "@tanstack/react-router";

import { BacklogSettings } from "../components/settings/BacklogSettings";

export const Route = createFileRoute("/settings/backlog")({
  component: BacklogSettings,
});
