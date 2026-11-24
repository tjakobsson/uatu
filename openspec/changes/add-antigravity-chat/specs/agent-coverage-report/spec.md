# agent-coverage-report Specification (delta)

## MODIFIED Requirements

### Requirement: Coverage is derived from the installed SDK and observed behavior

The coverage generator SHALL classify each supported agent's installed SDK vocabulary by exercising product normalization and rendering, and SHALL distinguish SDK-declared vocabulary from axes the SDK does not enumerate.

#### Scenario: Extract each supported agent's declared axes
- **WHEN** coverage is generated for any supported agent
- **THEN** extraction reads message types and subtypes, content-block or part types, and tool names where enumerated by that installed SDK
- **AND** classification MUST exercise product normalization and rendering rather than consult a maintained handling list

#### Scenario: An SDK does not enumerate an axis
- **WHEN** the installed SDK supplies no enumeration for a vocabulary axis
- **THEN** the report states that limitation instead of attributing a product-maintained list to the SDK

#### Scenario: A vocabulary entry is classified by what the code does
- **WHEN** the generator meets a message type the normalizer produces timeline updates for
- **THEN** the entry is reported as dedicated
- **AND** a type the normalizer deliberately drops is reported as ignored
- **AND** a type the normalizer neither handles nor lists is reported as unhandled

#### Scenario: A tool without purpose-built rendering is generic, not missing
- **WHEN** the generator meets a tool name the timeline renders through its generic tool row
- **THEN** the entry is reported as generic
- **AND** it is distinguished from tools with dedicated rendering and from tools that are dropped

#### Scenario: Extraction failure is loud
- **WHEN** an SDK's declaration files change shape so that a vocabulary axis yields no entries
- **THEN** the generator fails naming the file it could not read
- **AND** no report claiming an empty vocabulary is produced

#### Scenario: Extract a protocol SDK's vocabulary from its published schema
- **WHEN** coverage is generated for an agent reached through a protocol SDK that publishes a machine-readable schema, such as Antigravity through the Agent Client Protocol package
- **THEN** extraction reads the protocol's session update kinds and its agent and client methods from that installed schema
- **AND** classification exercises the agent's product normalization as for any other agent
- **AND** the report states that the protocol does not enumerate the agent's tool names
