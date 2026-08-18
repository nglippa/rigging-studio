# Development Environment

## Terminal

Prefer modern CLI tools when available.

- Use `rg` instead of `grep`.

- Use `fd` instead of `find`.

- Use `bat` instead of `cat`.

- Use `eza` instead of `ls`.

- Use `zoxide` for project navigation.

- Use `gh` for GitHub operations.

- Use `uv` instead of `pip` when appropriate.

- Prefer `git` CLI over manual file operations.

- Use `jq` for JSON processing when available.

Always check whether a preferred tool exists before falling back to POSIX equivalents.

## Development

Use Serena for:

- code navigation

- symbol lookup

- finding references

- semantic refactoring

Use Context7 whenever implementing or modifying:

- Godot

- React

- Next.js

- TypeScript

- Supabase

- Playwright

- external libraries

- APIs

Never rely on potentially outdated remembered documentation when Context7 is available.

For browser projects, use Playwright to verify functionality before declaring work complete.

Prefer the smallest, cleanest implementation over the fastest one.

Avoid unnecessary abstraction.

Preserve existing architecture unless explicitly asked to redesign it.

## External APIs

When implementing features that could benefit from external data or services:

- Check https://github.com/public-apis/public-apis for suitable public APIs before building equivalent infrastructure from scratch.
- Prefer maintained, documented APIs with HTTPS.
- Prefer free/open APIs when they satisfy the requirements.
- Verify the API is still active and confirm its current authentication, rate limits, licensing, pricing, and CORS behavior before implementation.
- Never assume information in the Public APIs catalog is current; treat it as a discovery index.
- Do not add an external API when an existing project dependency or native platform capability already solves the problem cleanly.