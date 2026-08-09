# hub-service — delta

## REMOVED Requirements

### Requirement: The hub provides a trusted local mode
**Reason**: The single trust model eliminates `--local`: localhost is just another address and login is required on every interface. The desktop no longer supervises a hub, so the URL-on-stdout parsing contract that local mode existed to serve has no consumer requirement (the `--port 0` and stdout-URL behaviors may persist as tooling conveniences but are no longer a specified contract of a trust mode).
**Migration**: Run `uatu hub` with a configuration file containing at least one user; the no-users startup error names the steps. Supervising processes that parsed the stdout URL switch to configuring an explicit port.
