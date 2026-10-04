import { createAgentMessageEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-messages";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentMessageEnvironment = createAgentMessageEnvironmentAtoms(connectionAtomRuntime);
