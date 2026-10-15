# dsh-study-note

English | [中文](README.zh.md)

A DeepSeek Harness plugin that turns explicitly opted-in conversations into structured Markdown study notes. Each conversation starts with recording off; enabling one conversation does not enable another.

## Quick start — tutorial

Requires Node.js 22.19+ and a DSH profile providing `commands`, `sessions`, and `llm`. Loader composition is tested against the installed DSH 0.1.0-rc.8 and the local 0.1.1-rc.2 build. Later releases are not yet verified. The package contains executable JavaScript and needs no install-time build.

1. Clone the plugin, install development dependencies, and create an installable archive:

   ```sh
   git clone https://github.com/WaterFountain-Jack/dsh-study-note.git
   cd dsh-study-note
   npm install
   npm pack
   ```

2. Install into your intended profile. This changes that profile; replace `desktop` if yours has another name. This package is not published to npm, so installing by npm name will not work.

   ```sh
   dsh plugin --profile desktop add "$PWD/dsh-study-note-0.1.0.tgz"
   dsh --profile desktop --dump-config
   ```

3. Restart that DSH profile if it has not hot-loaded the plugin. In a conversation, run the commands below as separate messages, then ask a learning question and let the assistant finish its answer:

   ```text
   /note on Cordis
   /note status
   ```

4. Recording runs in the background after a complete answer. `/note sync` checks all completed eligible turns immediately and retries pending failures; `/note status` reports the file and latest error. Verify the generated document and root index in the configured notes directory. Disable this conversation with `/note off`.

Uninstalling preserves notes and local state:

```sh
dsh plugin --profile desktop remove dsh-study-note
```

## Conversation controls — reference

| Command | Behavior |
| --- | --- |
| `/note on [topic]` | Enable this conversation; process only complete turns that begin after enabling. Repeating it does not reset the checkpoint. |
| `/note off` | Cancel and await background work, retain existing files. After success no new automatic writes occur for this conversation. |
| `/note status` | Show switch, directory, topic, file, pending work, and latest error. |
| `/note sync` | Process eligible completed turns now; requires recording on. Does not backfill the off interval. |
| `/note topic <topic>` | Pin a topic and move this conversation's existing note; rebuild the index. |
| `/note reindex` | Rebuild the plugin-owned root index, without a model call; also available while off. |
| `/note new` | Clear the association only after the old note is deleted or moved outside the root; leaves recording off. Use `on` for a fresh start without historical backfill. |

Topics contain 1–64 letters, Chinese characters, digits, underscores, or hyphens, starting with a letter or digit. A pinned topic can create a directory; automatic topic selection only uses existing directories, falling back to `inbox`. Subagent conversations cannot opt in.

## Notes and index — reference

```text
~/.dsh/study-notes/
├── README.md
├── Cordis/
│   └── 2026-10-15-Cordis-学习-<session-hash>.md
├── inbox/
└── .study-note/
    ├── state.json
    ├── writer.lock
    └── requests/
```

One document belongs to one conversation. A relevant question creates a section containing the question, one-line conclusion, explanation, formula/code/example, an AI-drafted understanding for you to rewrite, unresolved questions, and source turn/event numbers. Follow-ups can update an existing section; unrelated questions add sections. Notes do not certify correctness or mastery.

Hand-edited sections are not replaced: related follow-ups append a supplemental section instead. Preserve the HTML metadata and section markers. Renames and moves within the root are discovered on the next write or `/note reindex`; external edits are not watched continuously. Deleting a note does not silently recreate it. Keep one copy per conversation inside the root.

Only the region between `<!-- dsh-study-note:index:start -->` and `<!-- dsh-study-note:index:end -->` is maintained in `README.md`. Handwritten entries outside that region stay unchanged. Only this plugin's documents join its index; existing unrelated notes are not rewritten or automatically cataloged.

## Configuration — reference

The bundle entry id is `study-note`. An optional overlay selects a different root:

```yaml
- id: study-note
  config:
    notesDir: '~/study-notes'
```

Save the overlay at a path you choose and pass `--patch <absolute-overlay-path>` when launching the profile. Alternatively merge the entry into your profile patch, preserving other entries. This project does not change your active profile or existing knowledge base.

| Field | Default | Meaning |
| --- | --- | --- |
| `notesDir` | `~/.dsh/study-notes` | Absolute path or `~/` path; choose a separate directory for each simultaneous DSH process. |
| `debounceMs` | `1500` | Delay after a completed turn before background processing. |
| `timeoutMs` | `60000` | Auxiliary request deadline, including its audit write. |
| `provider`, `model` | absent | Supply both non-empty strings to override; otherwise reuse the completed answer's route. |
| `maxInputBytes` | `98304` | UTF-8 limit for the entire framed auxiliary request; oversize fails visibly. |
| `maxOutputBytes` | `65536` | Limit for serialized stream chunks, not only final text. |
| `maxOutputTokens` | `4000` | Auxiliary output-token cap. |
| `recentSections` | `6` | Most recent note sections supplied as follow-up context. |
| `maxMessageChars` | `12000` | Per question, answer, or section text limit; truncation is explicitly marked. |

## Privacy, cost, and failures — reference

Never-enabled conversations produce no recording files or auxiliary model calls. Recording selects human-origin text and the last complete assistant text from future completed turns; it excludes reasoning blocks, tool results, images, injected user messages, and interrupted output. Exact routine acknowledgements and progress questions are filtered locally; other irrelevant turns may still require a model call to decide to skip.

Each eligible turn can cause an additional paid request to the configured provider, including skipped content. Only one request runs at a time per conversation; different conversations may run concurrently. Prior note sections, including your edits in those sections, can enter these requests. The plugin does not read API keys or ambient environment values, but does not redact secrets that you typed into conversation text. Do not enable it for sensitive conversations unless that provider and local retention are acceptable.

Before dispatch, the exact system prompt, messages, route, token limit, and source event numbers are written to `.study-note/requests/`. These local audit files retain selected conversation text even if the model skips the turn or recording is then disabled. New files use owner-only permissions; they are not encrypted and existing parent permissions are not tightened. Disabling or uninstalling does not erase files; there is no automatic retention cleanup.

The auxiliary request is not inserted into the main model history or DSH session log. The tested host cannot safely register external informational session events, so replay requires keeping the plugin audit directory alongside the DSH conversation log. No shell command or model tool executes during recording.

Model errors, invalid JSON, truncation finishes, missing files, malformed markers, and permissions errors are reported by `/note status` and runtime logs. Fix the cause and use `/note sync`; failed model work may be billed again on retry. Note, state, and index are separate atomic file replacements, not one transaction; an index failure may leave a saved note, and sync rebuilds without regenerating that committed turn. A crash can cause duplicate model billing but note metadata prevents duplicate committed sections on recovery. Filesystem rename durability across sudden power loss is not guaranteed.

Only one writer may hold a notes directory. A crash may leave `.study-note/writer.lock`; confirm that its recorded process has stopped before removing only that lock and reloading the plugin. State changes after a read-only instance loads require reloading that instance. Do not share the root with untrusted writers or concurrently edit a section during an automatic save; file comparison detects many, not all, filesystem races.

## Development and distribution — reference

```sh
npm run check
npm test
npm run test:dsh
```

The Loader smoke defaults to the enclosing DSH checkout's built packages. For another installed DSH, set `DSH_PACKAGE_JSON` to its CLI `package.json` path. Only the external provider is simulated; no real API key or paid call is used. The smoke exercises real Loader, session, command, and LLM services and compares a normalized output snapshot. These checks do not assess real-provider note quality, desktop rendering, latest-host compatibility, or all operating systems.

See [publishing requirements](PUBLISHING.md) for community-market submission and [design decisions](DESIGN.md) for lifecycle and audit choices.
