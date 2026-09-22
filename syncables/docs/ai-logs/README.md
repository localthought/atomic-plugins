# Generative AI prompt/output logs

This folder is syncables' disclosure log for generative-AI use, kept to
comply with [NLnet's Generative AI policy](https://nlnet.nl/foundation/policies/generativeAI/)
for NLnet-funded work. It mirrors the same structure used in
[localthought/reflector](https://github.com/localthought/reflector/tree/main/docs/ai-logs),
the sibling project this engine is built for.

## What's logged here, and what isn't

syncables has been developed collaboratively with Claude Code (Anthropic),
an agentic coding assistant, since before this policy took effect. Per the
policy's own terms for already-ongoing projects, retroactive logging is not
required — this folder does not attempt to reconstruct every historical
session. What it does do:

- **Going forward**, each substantive Claude Code session that produces a
  commit gets a log under [`sessions/`](sessions), redacted per the rules
  below.
- **Historically**, some commit messages on this project already carry a
  `Claude-Session: https://claude.ai/code/session_...` trailer identifying
  the session that produced the commit. [`pending-historical-sessions.md`](pending-historical-sessions.md)
  indexes the session links already visible in git history that don't yet
  have a corresponding transcript here; entries move from "pending" to
  `sessions/` as transcripts become available to attach.
- Session logs capture the **substantive human prompts and the assistant's
  substantive outputs** — the actual asks and the actual answers/code
  changes. They do not reproduce the coding assistant's internal system
  prompt, tool-call plumbing, or other harness scaffolding verbatim: that
  content is Anthropic product internals rather than project-specific
  "prompts," and dumping it wouldn't add transparency about how *this
  project* was built.

## Redaction

Before anything is committed here, logs are reviewed and redacted for:

- credentials, tokens, and anything else that looks like a secret;
- personal information (e.g. email addresses) not otherwise already public
  about the project;
- any other session- or account-identifying detail that isn't needed to
  understand what was asked and what was produced.

Redacted spans are marked `[redacted]` inline rather than silently deleted,
so it's visible that a redaction happened.

## See also

- The [README's "Generative AI use" section](../../README.md#generative-ai-use)
  for the project-level summary this policy asks for.
- [NLnet's Generative AI policy](https://nlnet.nl/foundation/policies/generativeAI/).
