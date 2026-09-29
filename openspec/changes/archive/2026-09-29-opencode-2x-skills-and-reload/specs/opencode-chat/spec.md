## ADDED Requirements

### Requirement: Skills are offered as slash commands on every OpenCode generation
The command inventory Chat reports for an OpenCode agent SHALL include the skills OpenCode has loaded for the workspace, each as a command of kind `skill`, on both the 1.x and the 2.x generation. On 2.x, where OpenCode keeps skills in a catalog apart from its config commands, Chat SHALL read both catalogs and present their union together with Chat's own built-in commands; a name present in more than one source SHALL appear once, with a config command taking precedence over a skill of the same name and a built-in yielding to either. The slash palette SHALL mark a skill entry with a visible "skill" label so a skill and a command with similar names are told apart.

Submitting `/<skill> <arguments>` on 2.x SHALL invoke the skill the way OpenCode's own 2.x clients do: as a prompt that carries the skill as an attachment identified by the skill's id, whose text is the skill mention followed by the arguments (`@<skill-id> <arguments>`, or `@<skill-id>` alone when there are none). The resulting user turn SHALL read as that invocation in the live timeline and after the conversation's history is reloaded. A skill name OpenCode no longer knows at dispatch SHALL be refused in the conversation the way an invalid command is, and MUST NOT be sent as an ordinary prompt. Skill dispatch on 1.x is unchanged.

#### Scenario: A 2.x skill appears in the palette
- **WHEN** the workspace's OpenCode is 2.x and it has loaded a skill named `openspec-apply-change`
- **THEN** typing `/openspec` lists `/openspec-apply-change` with the skill's description and a "skill" label
- **AND** OpenCode's config commands and Chat's built-ins are listed alongside it

#### Scenario: A 2.x skill is invoked with arguments
- **WHEN** the user submits `/openspec-apply-change my-change` on a 2.x conversation
- **THEN** OpenCode receives a prompt with the skill attached and the text `@openspec-apply-change my-change`
- **AND** the conversation shows a user turn reading `@openspec-apply-change my-change`
- **AND** reopening the conversation shows the same user turn

#### Scenario: A skill OpenCode has since dropped is refused
- **WHEN** the user submits `/<skill>` for a skill that was in the palette but is no longer in OpenCode's catalog at dispatch
- **THEN** the conversation shows a refusal naming the skill and no prompt is sent

#### Scenario: A 1.x skill is unchanged
- **WHEN** the workspace's OpenCode is 1.x
- **THEN** skills are listed and dispatched as before this change, now with the "skill" label in the palette

### Requirement: Users can reload OpenCode's configuration on 2.x
When the running OpenCode generation offers configuration reload (2.x), Chat SHALL offer a built-in `/reload` command that asks OpenCode to reload its configuration for the workspace. It MUST NOT be offered on a generation without that operation (1.x). Reload applies to every conversation served by that OpenCode server; it requires no confirmation and SHALL NOT interrupt a running turn, which OpenCode continues under the reloaded configuration.

The conversation in which `/reload` was submitted SHALL show that the reload is in progress, then its outcome: success, or failure with the message OpenCode reported. The `/reload` turn SHALL NOT remain in the timeline as a user prompt and MUST NOT be sent to the model. Arguments after `/reload` are ignored: `/reload now` reloads the same way. After a successful reload, the client that invoked it SHALL re-read the agent's commands (including skills), models, and modes so the palette and pickers reflect the new configuration without a page reload. Any other open client SHALL show the reloaded catalogs no later than when it next starts a slash query, opens the configuration picker, or selects a conversation, without a page reload.

#### Scenario: Reload succeeds
- **WHEN** the user submits `/reload` on a 2.x conversation after adding a skill to the workspace's OpenCode configuration
- **THEN** the conversation shows the reload in progress and then "Configuration reloaded"
- **AND** the new skill appears in the palette without reloading the page

#### Scenario: Reload fails
- **WHEN** OpenCode refuses or fails the reload
- **THEN** the conversation shows the failure with OpenCode's message
- **AND** the catalogs shown are the ones from before the attempt

#### Scenario: Reload while another conversation is running
- **WHEN** a turn is running in another conversation of the same workspace and the user submits `/reload`
- **THEN** the reload proceeds without a confirmation prompt
- **AND** the running conversation is not interrupted

#### Scenario: Another open client sees the reloaded catalogs
- **WHEN** a second client has the same workspace's Chat open and another client's `/reload` added a skill
- **THEN** typing that skill's name after `/` in the second client lists it, without reloading the page

#### Scenario: Reload is not offered on 1.x
- **WHEN** the workspace's OpenCode is 1.x
- **THEN** `/reload` is not in the palette and submitting it is treated as ordinary prompt text
