import { createBacklogEnvironmentAtoms } from "@t3tools/client-runtime/state/backlog";

import { connectionAtomRuntime } from "../connection/runtime";

export const backlogEnvironment = createBacklogEnvironmentAtoms(connectionAtomRuntime);
