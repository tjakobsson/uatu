## ADDED Requirements

### Requirement: Failed document loads are classified as final or transient
When the server cannot answer a document request with the document, it SHALL classify the failure by whether it can recover on its own. A document the workspace index does not hold, or whose indexed path no longer resolves to a readable file (the file is missing, a path component is not a directory, the path is a directory, the path is a symbolic-link loop, or the path name is too long), SHALL be answered as not found (HTTP 404). A document the server process is not permitted to read (permission denied or operation not permitted) SHALL be answered as forbidden (HTTP 403) with an error body that identifies the document as not readable. A binary document SHALL be answered as not viewable (HTTP 415). Any other failure, including a renderer error, resource exhaustion such as too many open files, an I/O error, or an unrecognized error, SHALL be answered as a server failure (HTTP 500). The server SHALL record a server failure, with the document and its cause, in the session log. It MUST NOT log a not-found, forbidden, or not-viewable answer. Error bodies MUST NOT include the underlying error message or the filesystem cause.

The preview SHALL treat a load as transient only when the answer's status was a 5xx, 408 (Request Timeout) or 429 (Too Many Requests), or when the request received no complete answer: the request failed, or the body of a successful response stopped arriving before it was complete. It SHALL retry a transient failure on its bounded schedule, and it does not read a `Retry-After` header. Every other outcome SHALL be final and MUST NOT be retried automatically. This includes every other 4xx status and a successful status whose body cannot be parsed as a document payload. A failure answer whose body is not the server's JSON error body (for example a proxy's HTML error page), or whose body stopped arriving before it was complete, SHALL be classified by its status alone. A final failure SHALL show a notice that states its cause:
- forbidden: "Uatu doesn't have permission to read this file. Change its permissions, then select it again."
- not found: "File unavailable. It may have been removed or excluded from this workspace."
- any other final failure: "This file couldn't be loaded. Select it again to retry."

While a transient failure is still being retried, the preview SHALL show "This file couldn't be loaded. Retrying…". Once the schedule is used up, it SHALL show "This file couldn't be loaded. Select it again to retry." When the user selects the document again after a final failure, the preview SHALL make exactly one new request. It MUST NOT restart a retry cycle unless that request fails transiently.

#### Scenario: A permission-denied document is final
- **WHEN** the selected document exists in the index but the server process is not permitted to read it
- **THEN** the server answers 403 and writes nothing to the session log for that request
- **AND** the preview shows the permission notice without first showing "Retrying…"
- **AND** the preview makes no further request for that document until the user selects it again or the document changes

#### Scenario: Selecting a permission-denied document again makes one request
- **WHEN** the preview shows the permission notice and the user selects the same document again
- **THEN** the preview makes exactly one request for that document
- **AND** if the file is now readable the preview renders it, otherwise the permission notice remains without retries

#### Scenario: A document path that became a directory is not found
- **WHEN** an indexed document's path is replaced by a directory before the index catches up, and the document is requested
- **THEN** the server answers 404 and the preview shows the not-found notice without retrying

#### Scenario: A renderer failure is still retried
- **WHEN** the document is readable but rendering it fails
- **THEN** the server answers 500 and logs the document and the cause
- **AND** the preview shows "This file couldn't be loaded. Retrying…" and retries on its bounded schedule

#### Scenario: Resource exhaustion is still retried
- **WHEN** reading the document fails because the server has too many open files
- **THEN** the server answers 500 and the preview retries on its bounded schedule

#### Scenario: An unanswered request is retried
- **WHEN** the document request fails without any response, for example because the network dropped or the hub reports the session unreachable with a 5xx
- **THEN** the preview treats the failure as transient and retries on its bounded schedule

#### Scenario: A request timeout or rate limit in the path is retried
- **WHEN** the document request is answered 408 or 429, for example by a proxy in front of the session
- **THEN** the preview shows "This file couldn't be loaded. Retrying…" and retries on its bounded schedule
- **AND** once the schedule is used up it shows "This file couldn't be loaded. Select it again to retry."

#### Scenario: A proxy's error page is classified by its status
- **WHEN** the document request is answered 403 or 404 with a body that is not JSON
- **THEN** the preview does not retry
- **AND** a 403 shows "This file couldn't be loaded. Select it again to retry." and a 404 shows the not-found notice

#### Scenario: A failure answer whose body breaks is classified by its status
- **WHEN** the document request is answered with a failure status but the response body stops arriving before it is complete
- **THEN** a 403, 404 or 415 is final and is not retried, and a 403 shows "This file couldn't be loaded. Select it again to retry."
- **AND** a 408, 429 or 5xx is retried on the bounded schedule

#### Scenario: A successful answer whose body breaks is retried
- **WHEN** the document request is answered with a successful status but the response body stops arriving before it is complete
- **THEN** the preview treats the failure as transient and retries on its bounded schedule

#### Scenario: An unparseable successful answer is final
- **WHEN** the server answers the document request with a successful status but the body is not a valid document payload
- **THEN** the preview shows "This file couldn't be loaded. Select it again to retry." without retrying
