## ADDED Requirements

### Requirement: Session pages announce questions waiting in other workspaces
A hub-served session page SHALL show an in-app notice when the activity topic reports that another workspace the user may access has changed from not awaiting the user to awaiting the user, compared with the last state the page knew. The page's first activity report after it loads SHALL be its baseline; a page returning from the background or reconnecting SHALL compare against the state it last knew, so a question raised while it was hidden produces a notice on return. The notice SHALL name that workspace, say that an agent needs an answer, and offer Open and Dismiss. It SHALL NOT reveal conversation content, titles, questions, or tool details. A page SHALL NOT show a notice for the workspace it is serving, for a workspace already awaiting when the page loaded, or for an agent that finished without asking. At most one notice per workspace SHALL be shown at a time; notices for several workspaces SHALL stack with the newest first and SHALL NOT cover the chat composer, the touch-mode tab bar, or the hub navigation. A notice SHALL clear when dismissed, when opened, or when that workspace stops awaiting the user for any reason, including an answer from another device or the workspace stopping. The notice SHALL be independent of notification enrollment and SHALL NOT request an OS notification.

Open SHALL navigate to the named workspace with Chat as the active surface in the current UI mode and SHALL select the conversation whose interaction is awaiting the user, choosing the most recently raised one when several are waiting. If nothing is awaiting by the time the workspace opens, Chat SHALL open on its conversation list with a short note that the request was already answered, and SHALL NOT select an unrelated conversation as though it were the target. The destination link SHALL survive a login redirect.

#### Scenario: A question in another workspace raises a notice
- **WHEN** a user is working in workspace alpha and an agent in workspace beta asks a question
- **THEN** alpha's page shows a notice naming beta with Open and Dismiss
- **AND** the switcher chip still carries its awaiting badge

#### Scenario: Open lands on the waiting conversation
- **WHEN** the user presses Open on a notice for beta
- **THEN** beta opens with Chat in front and the conversation holding the question selected
- **AND** the pending question is available through the normal chat interaction

#### Scenario: The question is answered elsewhere first
- **WHEN** a notice for beta is showing and the question is answered from the user's phone
- **THEN** the notice clears without user action

#### Scenario: Open after the answer
- **WHEN** the user opens beta from a link whose request was answered before the page loaded
- **THEN** Chat shows its conversation list and a note that the request was already answered
- **AND** no conversation is selected as though it were the target

#### Scenario: The current workspace does not notify itself
- **WHEN** an agent in the workspace the page is serving asks a question
- **THEN** that page shows no notice for it

#### Scenario: Already-waiting workspaces stay quiet on load
- **WHEN** a user opens a session page while workspace beta is already awaiting an answer
- **THEN** the page shows no notice for beta
- **AND** the switcher badge reports beta as awaiting

#### Scenario: A question raised during a brief tab switch
- **WHEN** a user hides their session page for alpha for 10 seconds, an agent in beta asks a question meanwhile, and the user returns
- **THEN** alpha's page shows a notice for beta once it has reconnected
- **AND** no push was sent for that question

#### Scenario: Completions do not raise a notice
- **WHEN** an agent in another workspace finishes a turn without asking anything
- **THEN** no notice appears
- **AND** the switcher reports that workspace as finished

#### Scenario: Touch mode keeps the tab bar usable
- **WHEN** a notice appears on a page in touch mode
- **THEN** it is shown above the bottom tab bar and every tab remains reachable
