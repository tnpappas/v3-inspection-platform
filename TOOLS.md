# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## Operational lessons learned

### Model switching: always verify after a switch attempt

If a model-switch command (slash or tool parameter) returns an error, IMMEDIATELY pull `/status` to verify what is actually running. **Do not assume a failed switch reverted to a previous model or applied as expected.** Captured 2026-04-27 after a 3-hour run on Opus when Sonnet was expected.

Allowed model names in this OpenClaw deployment as of 2026-04-27:
- `anthropic/claude-opus-4-7` (default, 1M context window)
- `anthropic/claude-sonnet-4-6` (fallback, 200k context window)

NOT allowed (tried, failed):
- `claude-sonnet-4-5`
- `anthropic/claude-sonnet-4-5`
- `sonnet-4-5`
- `anthropic/claude-sonnet-4-7`

Context window constraint: Sonnet 4-6 has a 200k token window. Long sessions (anything over ~150k tokens) will show 337%+ context on Sonnet. For deep sessions, stay on Opus. Start a fresh session or compact before switching to Sonnet.

Alias shortcuts (per AGENTS.md header):
- `opus` → `anthropic/claude-opus-4-7`
- `sonnet` → `anthropic/claude-sonnet-4-6` (verify; the alias may resolve to 4-7 which is not confirmed available)


## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
