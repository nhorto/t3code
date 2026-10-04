import type { Notification } from "expo-notifications";
import { describe, expect, it } from "vite-plus/test";

import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { notificationDeepLinkOnScreen, threadDeepLinkOnScreen } from "./notificationPayload";

function notificationWithData(data: Record<string, unknown>): Notification {
  return {
    date: 0,
    request: { identifier: "notification-1", content: { data }, trigger: null },
  } as unknown as Notification;
}

describe("threadDeepLinkOnScreen", () => {
  it("maps a thread route and its nested screens to the thread deep link", () => {
    expect(threadDeepLinkOnScreen("/threads/env-1/thread-1")).toBe("/threads/env-1/thread-1");
    expect(threadDeepLinkOnScreen("/threads/env-1/thread-1/files/src")).toBe(
      "/threads/env-1/thread-1",
    );
  });

  it("returns null outside a thread", () => {
    expect(threadDeepLinkOnScreen("/")).toBeNull();
    expect(threadDeepLinkOnScreen("/settings")).toBeNull();
    expect(threadDeepLinkOnScreen("/threads/env-1")).toBeNull();
  });
});

describe("notificationDeepLinkOnScreen", () => {
  it("maps the Messages screen and threads, nothing else", () => {
    expect(notificationDeepLinkOnScreen("/backlog/messages")).toBe("/backlog/messages");
    expect(notificationDeepLinkOnScreen("/threads/env-1/thread-1/git")).toBe(
      "/threads/env-1/thread-1",
    );
    expect(notificationDeepLinkOnScreen("/backlog")).toBeNull();
  });
});

describe("foregroundNotificationBehavior", () => {
  it("suppresses a held message alert while the Messages screen is open", () => {
    const alert = notificationWithData({
      deepLink: "/backlog/messages",
      environmentId: "env-1",
      threadId: "thread-1",
    });
    expect(foregroundNotificationBehavior(alert, "/backlog/messages").shouldShowBanner).toBe(false);
    // The receiving thread being open does not make the alert redundant.
    expect(foregroundNotificationBehavior(alert, "/threads/env-1/thread-1").shouldShowBanner).toBe(
      true,
    );
  });

  it("suppresses a notification for the thread already on screen", () => {
    const behavior = foregroundNotificationBehavior(
      notificationWithData({ environmentId: "env-1", threadId: "thread-1" }),
      "/threads/env-1/thread-1",
    );
    expect(behavior.shouldShowBanner).toBe(false);
    expect(behavior.shouldShowList).toBe(false);
    expect(behavior.shouldPlaySound).toBe(false);
  });

  it("shows a notification for another thread", () => {
    const behavior = foregroundNotificationBehavior(
      notificationWithData({ deepLink: "/threads/env-1/thread-2" }),
      "/threads/env-1/thread-1",
    );
    expect(behavior.shouldShowBanner).toBe(true);
    expect(behavior.shouldShowList).toBe(true);
  });

  it("shows a notification when no thread is open or the payload has no target", () => {
    expect(
      foregroundNotificationBehavior(
        notificationWithData({ environmentId: "env-1", threadId: "thread-1" }),
        null,
      ).shouldShowBanner,
    ).toBe(true);
    expect(
      foregroundNotificationBehavior(notificationWithData({}), "/threads/env-1/thread-1")
        .shouldShowBanner,
    ).toBe(true);
  });
});
