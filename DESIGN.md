# Agent Note: Opt-in conversation study notes

Status: implemented

## Problem

Learning conversations contain reusable explanations mixed with temporary operations and acknowledgements. The user wants selective automatic organization without global recording, an approval queue, or a separate knowledge-management application.

## Decision

The standalone named-function Cordis plugin consumes the existing session event, human command, and LLM services. No agent-loop changes, model tools, or frontend are needed. Persistent opt-in and checkpoints belong to each session id; enabling establishes a new event-sequence boundary. Only complete human-led future turns enter the recorder. One conversation owns one Markdown document with individually hashed sections. Model JSON chooses semantic inclusion and an existing section, never a filesystem path. Pinned directories and a bounded README block provide the requested structural management.

Generation runs outside the foreground answer. Abort-aware per-session work checks an epoch before commits; off and disposal await work before returning. File mutations share one serialized queue and a single-writer filesystem lease. Section hashes turn edits into append-only follow-up supplements rather than overwrites. Note metadata carries the last committed source event, allowing recovery when note replacement succeeds before checkpoint replacement. Files use temp-write, fsync, and rename; there is no cross-file transaction or directory fsync promise.

### External-event logging limitation

The host requires model-visible inputs to be reconstructable from its session log. Its persistence reader rejects unknown required event types, its known-type set is generated from its own repository, and the tested `Session.append` API cannot set an `ignorable` envelope field for external log-only events. Adding a custom event from an out-of-tree plugin would make restored conversations unreadable. This plugin therefore records each exact auxiliary request before dispatch in a private local audit file, with source event references. This is an explicit deviation from the host's session-log-only rule, not equivalent session replay. An upstream external informational-event registration/append API is required to remove the deviation safely; borrowing unrelated event types or modifying the host is not part of this plugin.

## Alternatives considered

**Global automatic collection and approval queues** require subscription, review, and deletion workflows that the user explicitly excluded. Conversation-local opt-in makes the inclusion decision visible without that infrastructure.

**A skill alone** can guide manual summaries, but cannot independently observe completed turns, retain per-session switches, or own cancellation and file commits. The plugin uses runtime hooks while retaining a readable note format.

**One document per question** duplicates follow-ups and fragments related explanations. One document per conversation allows bounded section updates; it gives up cross-conversation topic synthesis.

**Replacing entire documents or root indexes** risks losing handwritten content. Hashed sections and a delimited index preserve edits but require keeping machine-readable markers.

## Consequences

Opt-in is persistent across plugin reloads, but disabled intervals and pre-enable history are not backfilled. The recorder adds auxiliary provider cost and retains selected conversation text in local audit files, including skipped turns. It does not certify accuracy or user understanding, offer approval review, redact secrets, or synchronize notes across machines. Independent DSH processes require independent roots. Manual filesystem changes are reconciled on writes or explicit reindex, not continuously watched.

## Verification

Focused Node tests pin selection, merging, section preservation, indexes, restart checkpoints, command ordering, failures, path validation, stale readers, and writer exclusion. The real Loader smoke uses built DSH service packages, a temporary YAML composition, real command dispatch and session appends, an auxiliary provider substitute, and a normalized note/index snapshot. It verifies background observation, disabled-session isolation, and aborting disposal on the installed 0.1.0-rc.8 and local 0.1.1-rc.2 builds. Real-provider semantics, desktop UI, newer DSH releases, abrupt power-loss behavior, and Windows/Linux execution remain unverified.
