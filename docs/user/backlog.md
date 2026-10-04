# Backlog

The Backlog keeps ideas, bugs and planned work next to the agents that do it. Each project has
its own board, and a personal **Inbox** catches anything not yet tied to a project.

## Capture

- On web and desktop, press `mod+shift+b` (or choose **Add to backlog** in the command palette).
  The dialog starts on the current project's board, or the Inbox. Customize `backlog.quickAdd` in
  **Settings → Keybindings**.
- On mobile, tap the Backlog button on the home screen, then **+**. Dictation works in the title.
- In any chat, ask the agent: "add a bug to Cork & Note: paywall crashes on iPad". Agents add,
  update and comment on issues for you.

Issues are numbered per board, such as `CN-12`. The short key comes from the project name; rename
it from the board header. Issue numbers never change, except that an issue moved out of the Inbox
gets the next number on its new board.

## Board

Open **Backlog** from the sidebar. Columns are Inbox, Backlog, Ready, In Progress, Review and Done;
drag a card to change its status. **Won't fix** is hidden until you show it. Open an issue to edit
it, comment, reopen it, or move an Inbox idea to a project.

An issue is **blocked** while any issue it depends on is still open. Agents only pick up issues
that are Ready, not blocked, and not already claimed.

Switch to **Graph** to see what blocks what, left to right. The longest chain of open issues, the
critical path, is highlighted; it is the order that decides when the work can finish. The graph is
on web and desktop.

## Agents and claims

An agent that starts on an issue **claims** it. Only one agent can hold an issue, across every
thread and provider. The card shows who holds it; open their thread from the issue.

A claim lasts 15 minutes and renews while the agent's thread is working or was active in the last
two hours, so an agent waiting on your answer keeps its issue. If the thread is archived, deleted or
idle longer than that, the issue returns to Ready on its own. To take an issue back sooner, open it and choose
**Release to Ready**.

To plan bigger work, paste a spec into an issue and ask an agent to break it down. It creates
child issues with the order they must happen in, and agents working the board claim only the ones
that are unblocked.

## Agents messaging each other

Agents can message other agents' threads on the same machine, in any project and with any
provider: to ask the agent holding an issue a question, to tell a waiting chat that its dependency
is done, or to tell everyone working a spec about a change. The receiver wakes up if it is idle;
a busy one gets the message as its next turn, unless the sender marked it urgent. The message shows
in the receiver's chat with a link to the sender, and the reply comes back the same way.

Choose **Messages** on the Backlog to see every agent message. To stop two agents looping, a
thread accepts at most 10 agent messages an hour. Further messages are **held**: the Backlog
sidebar button shows how many, and you can **Release** or **Dismiss** each one. Sending your own
message to that thread also lets its held messages through.

## Where the data lives

A board lives on one machine. Every client connected to that machine sees it live.

To let agents on several machines work the same boards, pick an always-on machine as the **hub**
and link the others to it:

1. On the hub, open **Settings → Connections**, choose **Create link**, pick the **Backlog link**
   permissions, and copy the URL.
2. On the other machine, open **Settings → Backlog**, choose **Link to a hub**, and paste the URL.

Agents on a linked machine then find, claim and update the hub's issues as if they were local, and
new project boards and Inbox ideas from their chats go to the hub. A board that already exists on
the linked machine stays there. If the hub is unreachable, agents are told so rather than working
from a stale copy. The link reaches only backlogs and lasts a year; unlink it from
**Settings → Backlog**, or revoke it on the hub under **Settings → Connections**.
