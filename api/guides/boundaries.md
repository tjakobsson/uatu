# Hub and workspace boundaries

The Hub API is UatuCode's public API. The Hub owns identity, registered workspaces, device sessions, credentials, clone jobs, workspace process lifecycle, each user's personal workspace state, and the live stream. The [OpenAPI document](../openapi.yaml) describes all of it, and `hubApiRevision` versions it.

The Hub runs each workspace as a child process on a loopback port and proxies it under `/s/{workspaceId}/`. The proxied routes cover documents, search, chat, and terminals. They are the internal protocol between the Hub, the child, and the web client that ships in the same build, so they change with that build and have no public revision. [exclusions.yaml](../exclusions.yaml) lists them so that none disappears silently. Do not build a client on them.

Personal state is the exception under that prefix. The Hub stores it per user and workspace and answers `/s/{workspaceId}/api/personal-state` itself, whether or not the workspace is running, so `workspaceGetPersonalState` and `workspacePatchPersonalState` are public Hub operations. What the Hub serves is public, and what it proxies to the child is internal.

Workspace updates reach public clients through the Hub's live stream, `GET /api/hub/live`. A client subscribes to one workspace's document state, its conversation inventory, and the conversations it follows. It can also ask for an activity summary of every workspace it may access: whether each one is running, whether an agent is working, and whether anything awaits the user. The document, inventory, and conversation payloads come from the workspace, so `workspaceApiRevision` versions them.

`workspaceId` is a stable Hub identifier, not a filesystem path, display name, or process ID. Authentication happens at the Hub. Never pass a Hub session to a workspace process, and do not assume a workspace listens on a reachable port.
