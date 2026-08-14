# Hub and workspace boundaries

The Hub is the public compatibility entry point. It owns identity, registered workspaces, device sessions, clone jobs, and workspace process lifecycle. Workspace APIs own documents, repository state, search, personal workspace state, and terminal sessions.

Clients normally reach a workspace through the Hub at `/s/{workspaceId}/`. Keep that prefix when resolving paths from the OpenAPI contract. `workspaceId` is a stable Hub identifier, not a filesystem path, display name, or process ID.

Authentication is established with the Hub and brokered to proxied workspace requests. Do not send internal workspace credentials directly or assume a workspace listens on a publicly reachable port.

The combined [OpenAPI document](../openapi.yaml) describes both domains. Operation tags and operation ID prefixes indicate ownership; the separate Hub and workspace revisions indicate which domain changed incompatibly.
