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

A claim lasts 15 minutes and renews while the agent's thread is running. If the thread stops, the
issue returns to Ready on its own. To take an issue back sooner, open it and choose
**Release to Ready**.

To plan bigger work, paste a spec into an issue and ask an agent to break it down. It creates
child issues with the order they must happen in, and agents working the board claim only the ones
that are unblocked.

## Where the data lives

A board lives on the machine that created it. Every client connected to that machine sees it
live.
