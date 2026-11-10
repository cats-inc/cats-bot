# ADR-017: Attach Owner Files through the Working Directory

## Status

Accepted — 2026-11-10, at the owner's request to bring Cats Desktop's composer attachments to the
note. Specified by [SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md) FR-8.

## Context

- Cats Desktop attaches files by writing them to `.cats-attachments/` in the conversation's working
  directory and starting the message with an `[Attached files in working directory:]` block that lists
  their relative paths. The provider CLI reads them with its own file tools. Its transcript shows the
  block's images inline and other files as names.
- cats-runtime 0.6.2's `POST /sessions/{id}/messages` takes only a `message` string. It has no image or
  file parts, and its `/media/images` routes generate images rather than accept them.
- Bots run natively only (ADR-010), so a bot's working directory on this computer is the directory its
  CLI sees.
- A note reaches the core through the host channel, whose frames are limited to 16 MiB.

## Decision

1. Attachments use Cats Desktop's form unchanged:
   - Files go to `.cats-attachments/` in the bot's working directory (`permissions.cwd`), with a
     `.gitignore` of `*`.
   - A taken name gets a numbered one, so nothing is replaced.
   - The message starts with the same block, so the same message reads the same in both products.
2. The core stores a file (`addOwnerAttachment`) and reads an attached image back for the note
   (`attachmentPreview`). The note uploads one file per call, base64, at most 10 MB per file, so each
   call fits in one channel frame.
   - `attachmentPreview` reads only a regular file inside the directory, by name, and only PNG, JPEG,
     GIF or WebP. Links and other paths read as nothing.
   - A `.cats-attachments` that is a link, not a directory, is refused for writing and reading: the
     working directory is where the CLI writes, and a planted link would send the owner's files elsewhere.
   - Names lose directories, reserved characters, trailing dots and spaces; Windows device names (CON,
     NUL, COM1…) get a leading `_`, and names are kept under 200 bytes.
3. The transcript keeps the message text only. The block is how a bubble knows its files; no transcript,
   work-item or profile format changes.

## Consequences

### Positive

- No runtime or data-format change; an older build shows the same message as plain text with the block.
- Every provider that can read files from its working directory can use attachments.

### Negative

- Attachments stay in the working directory until someone removes them; nothing cleans them up.
- A bot whose working directory is not the CLI's (a later WSL or docker environment) needs this
  revisited before it can attach files.
- Files larger than 10 MB are refused in the note.

### Neutral

- Like Cats Desktop, the note has no drag-and-drop or paste of files yet.
- A region screenshot (SPEC-003 FR-9, ported from Cats Desktop's host) becomes one more file in the
  composer and is stored the same way.
