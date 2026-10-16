# Telegram Integration - Security Review

**Date:** 2026-04-08
**Scope:** All Telegram bot integration modules
**Status:** 🟠 PARTIALLY RESOLVED

## Resolution Status

| Finding | Severity | Status |
|---------|----------|--------|
| Empty whitelist = allow all | 🔴 CRITICAL | ✅ RESOLVED — deny-by-default + start() rejects empty list |
| Bot token in plaintext | 🔴 CRITICAL | ⬜ OPEN — mitigated by .gitignore + deploy stripping |
| No input sanitization / length limit | 🟠 HIGH | ⬜ OPEN — auth layer is primary control (by design) |
| Terminal output mirroring | 🟠 HIGH | ⬜ OPEN — by design, auth layer is primary control |
| No rate limiting on commands | 🟠 HIGH | ✅ RESOLVED — per-user 30 msg/min inbound rate limit |
| HTML escaping incomplete | 🟡 MEDIUM | ✅ RESOLVED — added `"` and `'` escaping |
| Session IDs exposed | 🟡 MEDIUM | ⬜ OPEN |
| Weak callback data parsing | 🟡 MEDIUM | ⬜ OPEN |
| No audit logging | 🟡 MEDIUM | ⬜ OPEN |
| Spawn wizard state tracking | 🟢 LOW | ⬜ OPEN |
| Stale topic cleanup guardrails | 🟢 LOW | ✅ RESOLVED — preview + confirm, Helm-known mappings only |

---

## Executive Summary

The Telegram integration provides remote terminal control capabilities, which introduces significant security risks. The current implementation has **CRITICAL vulnerabilities** that could allow unauthorized access to terminals, data exfiltration, and denial of service.

**Overall Risk Rating: 🔴 HIGH**

---

## Findings

### 🟢 LOW: Stale Topic Cleanup Guardrails

**Location:**
- `src/telegram/topic-manager.ts`
- `src/telegram/callback-handler.ts`
- `src/telegram/keyboards.ts`

**Issue:** Telegram bots cannot enumerate every forum topic in a supergroup.
Cleanup must therefore avoid pretending it can delete arbitrary stale topics.

**Resolution:** The cleanup workflow is limited to Helm-known `topicId`
mappings, previews the probe result before changing anything, and requires a
confirmation callback before clearing dead mappings. Alive topics are treated as
belonging to active sessions and are skipped.

---

### 🔴 CRITICAL: Empty Whitelist = Allow All

**Location:** `src/telegram/bot.ts:279-283`

```typescript
private isAuthorized(userId: number | undefined): boolean {
  if (!userId) return false;
  if (this.allowedUserIds.size === 0) return true; // ⚠️ DANGEROUS DEFAULT
  return this.allowedUserIds.has(userId);
}
```

**Issue:** When `allowedUserIds` is empty (the default), ALL users are authorized. Anyone with access to the Telegram chat can execute commands, spawn sessions, and read terminal output.

**Default config:** `src/config/loader.ts:143`
```typescript
allowedUserIds: [],  // Empty = no restrictions!
```

**Impact:** Complete loss of access control if user doesn't explicitly configure whitelist.

**Recommendation:**
```typescript
// Change default behavior to deny-by-default
private isAuthorized(userId: number | undefined): boolean {
  if (!userId) return false;
  if (this.allowedUserIds.size === 0) {
    logger.warn('[Telegram] Access denied: no allowedUserIds configured');
    return false; // Deny by default
  }
  return this.allowedUserIds.has(userId);
}
```

Also consider adding a config flag `allowUnlistedUsers: false` for users who explicitly want open access.

---

### 🔴 CRITICAL: Bot Token Stored in Plaintext

**Location:** `src/config/loader.ts` - stored in `settings.yaml`

**Issue:** The Telegram bot token is stored in plaintext on disk. If an attacker gains access to the config directory, they can:
- Take control of the bot
- Access all Telegram messages
- Impersonate the bot
- Potentially access other chats the bot is in

**Impact:** Full compromise of the Telegram bot and any data it has access to.

**Recommendation:**
1. Use OS-level credential storage (Windows Credential Manager, macOS Keychain, Linux Secret Service)
2. At minimum, document that `config/` directory should have restricted filesystem permissions
3. Consider offering an option to require token entry on each startup (no persistence)

---

### 🟠 HIGH: No Input Sanitization Before PTY Write

**Location:**
- `src/telegram/commands.ts:167` - `/send` command
- `src/telegram/text-input.ts:93` - Text input confirmation

**Issue:** User input is written directly to PTY without validation or sanitization:
```typescript
ptyManager.write(sessionId, args.trim() + '\r');
```

**While the PTY itself is a terminal interface**, the integration doesn't:
1. Limit command length
2. Rate-limit inputs
3. Filter dangerous shell metacharacters (depending on context)

**Impact:**
- **DoS:** Flood terminal with garbage input
- **Command injection:** If terminal is at a shell prompt, arbitrary commands can be executed
- **Data destruction:** Commands like `rm -rf` could be sent

**Recommendation:**
1. Add max length limits (e.g., 1000 chars)
2. Add per-user rate limiting on `/send` and text input
3. Consider an "emergency stop" that disables Telegram control
4. Log all PTY writes from Telegram for audit

---

### 🟠 HIGH: Terminal Output Mirroring Leaks Sensitive Data

**Location:** `src/telegram/terminal-mirror.ts`

**Issue:** ALL terminal output is mirrored to Telegram topics, including:
- Passwords (when typed)
- API keys/tokens
- Private data
- Session cookies
- Database queries with sensitive data

**Current mitigation:** None. Output is only truncated for size, not content.

**Impact:** Data exfiltration via Telegram. Anyone with access to the chat can see sensitive terminal output.

**Recommendation:**
1. Add content filtering/redaction patterns
2. Provide an option to disable mirroring entirely
3. Add "privacy mode" that blocks output mirroring but keeps commands working
4. Consider opt-in per-session for mirroring

Example redaction patterns:
```typescript
const REDACT_PATTERNS = [
  /password["\s:=]+[^\s]*/gi,
  /token["\s:=]+[^\s]*/gi,
  /api[_-]?key["\s:=]+[^\s]*/gi,
  /-----BEGIN[A-Z]+ KEY-----[\s\S]+?-----END[A-Z]+ KEY-----/g,
];
```

---

### 🟠 HIGH: No Rate Limiting on Dangerous Commands

**Location:** `src/telegram/commands.ts` and `src/telegram/callback-handler.ts`

**Issue:** Commands like `/spawn`, `/close`, and `/closeall` have no rate limiting.

**Impact:**
- Resource exhaustion via `/spawn`
- Disruption via `/close` (close user's sessions)
- Mass deletion via `/closeall`

**Recommendation:**
1. Add rate limiting per-user for destructive commands
2. Consider requiring confirmation for `/closeall` (it already has confirmation, but rate limiting still needed)
3. Add a cooldown after `/closeall`

---

### 🟡 MEDIUM: HTML Escaping Incomplete

**Location:** `src/telegram/utils.ts:4-9`

```typescript
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

**Issue:** Double quotes are not escaped. In HTML attributes, this could lead to attribute injection.

**Current usage:** Only used in HTML message body (not attributes), so impact is limited.

**Recommendation:** Add quote escaping or switch to Telegram's Markdown mode which may be safer:
```typescript
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
```

---

### 🟡 MEDIUM: Session IDs Exposed in Messages

**Location:** Various - session IDs sent in plaintext

**Issue:** Session UUIDs are sent in messages, allowing attackers to:
- Track which sessions exist
- Potentially guess valid IDs for enumeration
- Correlate activity across messages

**Impact:** Information disclosure that aids further attacks.

**Recommendation:**
1. Use short, random aliases instead of full UUIDs
2. Don't expose session IDs in error messages
3. Consider adding a random "token" per session for Telegram operations

---

### 🟡 MEDIUM: Weak Callback Data Parsing

**Location:** `src/telegram/callback-handler.ts:100-101`

```typescript
const [action, ...rest] = data.split(':');
const payload = rest.join(':');
```

**Issue:** No validation that callback data matches expected format. A crafted callback could potentially cause issues.

**Impact:** Potential for unexpected behavior or crashes.

**Recommendation:**
1. Add strict format validation
2. Use a more structured format (e.g., JSON with signature)
3. Validate all parsed values

---

### 🟡 MEDIUM: No Audit Logging

**Issue:** Security-sensitive actions (spawn, close, PTY writes) are not logged to a dedicated audit log.

**Impact:** Difficulty detecting and investigating security incidents.

**Recommendation:**
1. Add structured audit logging for all Telegram-triggered actions
2. Include: user ID, action, timestamp, result
3. Consider sending audit events to a separate channel

---

### 🟢 LOW: Spawn Wizard State Tracking

**Location:** `src/telegram/callback-handler.ts:378`

```typescript
const spawnWizardState = new Map<number, { tool: string; createdAt: number }>();
```

**Issue:** State is stored in-memory and never expires automatically. Relies on manual cleanup + 5-minute TTL check on use.

**Impact:** Minor memory leak possibility. TTL check on read prevents stale state use.

**Recommendation:** Add periodic cleanup of expired entries.

---

## Positive Security Controls

The following security controls are already in place:

✅ **User ID whitelist support** - `allowedUserIds` allows restricting access
✅ **Message edit rate limiting** - 20 edits/minute per topic
✅ **HTML escaping** - Prevents XSS in Telegram HTML messages
✅ **PTY input timeout** - 5-minute expiry on pending text input
✅ **Safe mode default** - Text input requires confirmation before sending
✅ **Authorization check** - All callbacks/messages validate user ID

---

## Recommendations Priority

### Immediate (Before Wider Use)
1. ✋ Change `allowedUserIds` empty behavior to **deny-by-default**
2. 🔒 Add content redaction for sensitive terminal output
3. 🚨 Add rate limiting on `/send` and `/spawn`
4. 📝 Document security model and recommended setup

### Short Term
5. 🔐 Encrypt bot token at rest (OS credential store)
6. 📊 Add audit logging for all Telegram actions
7. ⏱️ Add session timeout options
8. 🚷 Add "privacy mode" to disable output mirroring

### Long Term
9. 🛡️ Consider adding end-to-end encryption for sensitive commands
10. 🔑 Add per-session authentication tokens
11. 📈 Add monitoring/alerting for suspicious activity patterns

---

## Testing Recommendations

1. **Authorization bypass testing** - Verify empty whitelist denies access
2. **Input fuzzing** - Send malformed inputs to all command handlers
3. **Rate limiting verification** - Attempt to flood with commands
4. **Data leak testing** - Verify sensitive data doesn't leak to Telegram
5. **Session hijacking** - Attempt to access another user's session

---

## References

- `src/telegram/bot.ts` - Core bot with auth check
- `src/telegram/commands.ts` - Slash command handlers
- `src/telegram/callback-handler.ts` - Inline keyboard handlers
- `src/telegram/text-input.ts` - Free-text input to PTY
- `src/telegram/terminal-mirror.ts` - PTY output streaming
- `src/config/loader.ts` - Config persistence
- `renderer/components/settings/pages/TelegramTab.vue` - Settings UI
