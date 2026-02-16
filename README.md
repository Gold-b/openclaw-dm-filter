# openclaw-dm-filter

**Stop wasting tokens on junk DMs.** Gateway-level keyword filtering for OpenClaw WhatsApp Direct Messages.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: WhatsApp](https://img.shields.io/badge/platform-WhatsApp-25D366?logo=whatsapp&logoColor=white)](https://github.com/nicepkg/openclaw)

---

## The Problem

OpenClaw filters **group** messages using `mentionPatterns` — messages that don't match a keyword never reach the AI agent (zero token cost).

But **DMs have no such filter.** Every DM triggers a full AI session, even when the agent stays silent because no keyword matched:

1. Loads your entire `AGENTS.md` instructions (~950 tokens)
2. Reads your `rules.json` knowledge base via tool call (~1,000 tokens)
3. Processes, decides not to respond (~550 tokens)

**Result:** ~2,500 tokens burned per junk DM just for the AI to stay silent.

## The Solution

This hook adds the missing DM filter at the gateway level — **before the AI agent is invoked.** Non-matching DMs are dropped silently. Cost: **$0.**

```
BEFORE                              AFTER
Every DM → AI agent → silent        Matching DMs → AI agent → responds
           (~2,500 tokens wasted)    Non-matching → dropped (zero tokens)
```

---

## Key Features

- **Smart Filtering** — Reuses your existing `mentionPatterns` config. No extra setup needed.
- **God Mode Bypass** — Automatically detects super-users and `!godmode` commands so admins are never locked out.
- **Fail-Safe** — If the filter encounters any error, it defaults to pass-through. No messages are ever lost.
- **High Performance** — Regex caching (hash-based) + admin config caching (mtime-based). Near-zero overhead.
- **Token Counter** — Tracks dropped messages and estimated token savings in real-time.
- **Language Agnostic** — Works with any language and Unicode script (English, Hebrew, Arabic, Chinese, etc.).
- **Selective Read Receipts** — Blue ticks sent only when the bot actually responds. Non-matching messages stay unread.

---

## Quick Start

### 1. Install

```bash
npx openclaw-dm-filter install
```

This copies the patch to `~/.openclaw/patches/on-message-hotfix.js`.

### 2. Docker-compose setup

Make sure your `docker-compose.yml` entrypoint copies the patch on container startup:

```yaml
services:
  gateway:
    image: ghcr.io/nicepkg/openclaw:latest
    entrypoint: ["/bin/sh", "-c"]
    command: >
      cp /home/node/.openclaw/patches/on-message-hotfix.js
      /app/dist/web/auto-reply/monitor/on-message.js 2>/dev/null || true;
      exec node /app/dist/index.js gateway --port 18789 --verbose
    volumes:
      - ~/.openclaw:/home/node/.openclaw
```

### 3. Restart

```bash
docker compose down && docker compose up -d
```

### 4. Verify

```bash
docker logs <your-gateway-container> 2>&1 | grep DM-FILTER
```

---

## Configuration

The filter reads keywords from `openclaw.json` at `messages.groupChat.mentionPatterns`. Configure via your admin panel, or manually:

```json
{
  "messages": {
    "groupChat": {
      "mentionPatterns": ["hello", "help", "pricing", "precio", "مرحبا"]
    }
  }
}
```

Both exact strings and regex patterns are supported. Matching is case-insensitive.

**Any language works** — keywords can be in English, Arabic, Spanish, Hebrew, Chinese, or any other language. The filter uses standard regex matching with full Unicode support.

---

## How It Works

```
DM arrives at gateway
    │
    ├─ Empty mentionPatterns? ──────────── ALLOW (no filtering configured)
    │
    ├─ God Mode super-user (passwordless)? ALLOW (bypass)
    │
    ├─ noKeywordRestrictions rule exists? ─ ALLOW (match-any rule)
    │
    ├─ God Mode command (!godmode, /exit)?  ALLOW (let agent handle)
    │
    ├─ Message matches any keyword? ─────── ALLOW (proceed to AI)
    │
    └─ No match ────────────────────────── DROP (silent, zero tokens)
```

### Bypass Rules

Messages that always pass through the filter:

| Bypass | Reason |
|--------|--------|
| Empty `mentionPatterns` | No keywords configured — filter is a no-op |
| Passwordless God Mode users | Super-users bypass all automation. Israeli phone normalization included; non-Israeli numbers use exact match |
| `!godmode <password>` | Activation command must reach the AI agent |
| `/exit`, `/godmode off` | Deactivation commands must reach the AI agent |
| `noKeywordRestrictions` rules | A rule that matches any message exists — no point filtering |
| Any error | Graceful fallback — message goes through, agent re-checks |

---

## Example Terminal Output

```
[DM-FILTER] ✓ Allowed — matched pattern: /pricing/i
[DM-FILTER] ✗ Dropped "hey whats up" — no keyword match | saved ~2,500 tokens (total: 1 dropped, ~2,500 tokens saved)
[DM-FILTER] ✓ Allowed — matched pattern: /hello/i
[DM-FILTER] ✗ Dropped "random spam message" — no keyword match | saved ~2,500 tokens (total: 2 dropped, ~5,000 tokens saved)
[DM-FILTER] Passwordless God Mode super-user — bypassing filter
[DM-FILTER] ✗ Dropped "some irrelevant text" — no keyword match | saved ~2,500 tokens (total: 3 dropped, ~7,500 tokens saved)
```

The filter tracks a running total of dropped messages and estimated token savings since the last container restart.

---

## Performance

| Aspect | Implementation |
|--------|---------------|
| Regex compilation | Cached. Recompiles only when `mentionPatterns` changes (hash-based invalidation) |
| Admin config reads | Cached. Re-reads only when file modification time changes (mtime-based) |
| Error handling | Entire filter wrapped in try-catch. Any failure = pass-through to AI agent |
| Memory footprint | Single compiled regex array + one cached config object |

---

## CLI Commands

```bash
npx openclaw-dm-filter install    # Install the patch
npx openclaw-dm-filter uninstall  # Restore from backup
npx openclaw-dm-filter status     # Check installation & keyword count
npx openclaw-dm-filter help       # Show help
```

## Uninstall

```bash
npx openclaw-dm-filter uninstall
docker compose down && docker compose up -d
```

---

## Language & Region Support

This plugin is **language-agnostic** and works worldwide:

- **Keywords**: Any language, any script (Latin, Arabic, CJK, Cyrillic, Hebrew, etc.)
- **Regex**: Full Unicode support — patterns like `precio|price|מחיר|السعر` work as expected
- **Phone numbers**: All international formats supported via exact match. Israeli numbers get bonus normalization (`05X` / `972X` / `+972X` variants auto-matched) for God Mode super-user detection — this does not affect non-Israeli users in any way
- **Documentation & CLI**: Fully in English

---

## Roadmap

Planned features for future releases:

- **VIP Whitelist** — Allow specific users (not just God Mode admins) to bypass the keyword filter. Useful for VIP customers who should always reach the AI agent regardless of keywords.
- **Token Savings Dashboard** — Expose cumulative filter stats via API endpoint for admin panel integration.
- **Custom Drop Response** — Optional auto-reply for dropped messages (e.g., "Please include a keyword from our menu").

---

## Contributing

This is an open-source project. If you have ideas for more cost-saving hooks or features, feel free to open an issue or submit a pull request!

**Love this? Give it a star to help others find it!**

---

## License

[MIT](LICENSE)

---

*Developed by [Or Goldberg (aka Gold-B)](https://github.com/Gold-b) & Claude Code*
