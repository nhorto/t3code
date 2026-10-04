import { RELAY_HELD_AGENT_MESSAGES_DEEP_LINK } from "@t3tools/contracts/relay";

function dataFromNotificationResponse(response: unknown): Record<string, unknown> | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const content = (request as { readonly content?: unknown }).content;
  if (typeof content !== "object" || content === null) {
    return null;
  }
  const data = (content as { readonly data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

function identifierFromNotificationResponse(response: unknown): string | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const identifier = (request as { readonly identifier?: unknown }).identifier;
  return typeof identifier === "string" ? identifier : null;
}

function encodeThreadDeepLink(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string | null {
  if (input.environmentId.length === 0 || input.threadId.length === 0) {
    return null;
  }
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

function normalizeThreadDeepLink(value: string): string | null {
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = value.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "threads") {
    return null;
  }

  try {
    return encodeThreadDeepLink({
      environmentId: decodeURIComponent(parts[2] ?? ""),
      threadId: decodeURIComponent(parts[3] ?? ""),
    });
  } catch {
    return null;
  }
}

/**
 * The deep link a notification would have to carry to target the thread the
 * given route is showing, including its nested screens such as the file
 * inspector. Null when the route is not inside a thread.
 */
export function threadDeepLinkOnScreen(pathname: string): string | null {
  const match = /^\/threads\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return `/threads/${match[1]}/${match[2]}`;
}

/**
 * The deep link a notification would carry to target what the route shows: a
 * thread (including its nested screens) or the agent Messages screen. Null
 * elsewhere.
 */
export function notificationDeepLinkOnScreen(pathname: string): string | null {
  return pathname === RELAY_HELD_AGENT_MESSAGES_DEEP_LINK
    ? RELAY_HELD_AGENT_MESSAGES_DEEP_LINK
    : threadDeepLinkOnScreen(pathname);
}

export function extractAgentNotificationDeepLink(response: unknown): string | null {
  const data = dataFromNotificationResponse(response);
  const deepLink = data?.deepLink;
  // Held agent message alerts open the Messages screen. Only this exact path is
  // accepted, and it wins over the receiving thread ids the payload also carries.
  if (deepLink === RELAY_HELD_AGENT_MESSAGES_DEEP_LINK) {
    return RELAY_HELD_AGENT_MESSAGES_DEEP_LINK;
  }
  if (typeof deepLink === "string") {
    const normalizedDeepLink = normalizeThreadDeepLink(deepLink);
    if (normalizedDeepLink) {
      return normalizedDeepLink;
    }
  }

  const environmentId = data?.environmentId;
  const threadId = data?.threadId;
  if (typeof environmentId === "string" && typeof threadId === "string") {
    return encodeThreadDeepLink({ environmentId, threadId });
  }
  return null;
}

export function routeAgentNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
}): void {
  const responseId = identifierFromNotificationResponse(input.response);
  if (responseId && input.handledResponseIds.has(responseId)) {
    return;
  }
  if (responseId) {
    input.handledResponseIds.add(responseId);
  }
  const deepLink = extractAgentNotificationDeepLink(input.response);
  if (deepLink) {
    input.navigate(deepLink);
  }
}
