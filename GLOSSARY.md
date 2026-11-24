# Uatu

Uatu brings document review and agent conversations into a workspace. These terms describe its conversation workflows and how the Hub runs workspaces.

## Language

### Conversations

**Composer**:
A conversation's input workflow, encompassing its draft and attachments, message submission, pending-message actions, side questions, and reversible history changes.

**Draft**:
The editable text and attachments being prepared for a conversation, distinct from input already submitted for delivery.

**Native history**:
The conversation transcript stored by its owning agent, distinct from Uatu's displayed or reconstructed conversation.

**Stop eligibility**:
The ability to offer Stop for a worker based on current execution and ownership evidence. Eligibility is not authorization to perform the action without fresh revalidation.

**Stop authorization**:
The fresh confirmation that a particular worker may be stopped when the action is performed, distinct from its previously displayed Stop eligibility.

### Hub and workspaces

**Workspace session**:
The private process the Hub starts to serve one workspace, distinct from the Hub itself and from a browser page viewing that workspace.
_Avoid_: child, serve process, backend

**Session contract**:
The private agreement between the Hub and a workspace session: how a session is started, proves it is ready, is addressed and is trusted. It is not part of the published Hub API.
_Avoid_: child protocol, internal API

**Session link**:
The Hub's handle to one running workspace session, through which every request to that session is addressed and trusted.
_Avoid_: running session, child link
