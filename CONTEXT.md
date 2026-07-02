# Context

Canonical vocabulary for AI HQ.
Use these names in code, tests, issues, and docs.

## Glossary

- **HQ**: this product - a local-first control plane where the Operator commands, monitors, and gates a fleet of agent sessions.
- **Operator**: the human running HQ (Daniel). The only actor in the system.
- **Session**: one delegated unit of agent work - an agent run against a repo with a task prompt. Lifecycle: `running` -> `waiting_on_human` -> `completed` / `failed` / `interrupted` (the Operator cut it off).
- **Event**: one immutable record of something a session did (message, tool call, lifecycle change). Events are append-only.
- **Event Log**: the source of truth. An append-only store of Events; everything else is a Projection over it.
- **Projection**: derived, rebuildable state (session list, decision list) computed from the Event Log.
- **Transcript**: the human-readable rendering of a session's Events.
- **Gated tool call**: a tool call the agent may not execute without the Operator's Verdict.
- **Decision**: a parked Gated tool call awaiting the Operator. Holds tool name, input, and status (`pending` / `approved` / `denied`).
- **Verdict**: the Operator's ruling on a Decision - approve, or deny with an optional note that is relayed to the agent.
- **Decision Inbox**: the UI surface aggregating pending Decisions across all Sessions.
- **AgentAdapter**: the only interface allowed to know which agent platform is underneath (launch, event stream, permission callback, interrupt, resume). Everything Claude-specific lives behind it.
- **Notifier**: the Daemon component that watches the Event Log and fires native macOS notifications (via osascript) when a Decision parks, a Session completes, or a Session fails.
- **Daemon**: the single long-running local process hosting the Event Log, Session Registry, Decision Queue, API, and Notifier.
