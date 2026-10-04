const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const BACKLOG_INSTRUCTIONS = `<backlog>
The \`backlog_*\` tools of the t3-code MCP server are the user's issue board, shared by every agent on every machine. When the user asks to add an idea, bug, or feature to a project, call \`backlog_create_issue\` with the project's id (\`backlog_guide\` lists the projects on this machine; no project means the Inbox). Before breaking a spec into work or working through a backlog, read \`backlog_guide\`. Claim an issue (\`backlog_claim\` or \`backlog_claim_next\`) before working on it, and release it with \`backlog_release\` when done.

To ask the agent holding an issue a question, tell a waiting chat its dependency is done, or tell everyone working a spec about a plan change, use \`agent_message\` (\`issue\`, \`threadId\`, or \`spec\`). It wakes the receiver in any project on this machine. Replies arrive as a new turn in your thread, so do not poll for them. A message that starts with "Message from another agent" came from \`agent_message\`; answer it with \`agent_message\` to the thread id it names.
</backlog>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${BACKLOG_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
