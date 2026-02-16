// openclaw-dm-filter — DM keyword pre-filter for OpenClaw gateway
// Copyright (c) 2026 Or Goldberg (aka Gold-B). MIT License. https://github.com/Gold-b/openclaw-dm-filter

import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { logVerbose } from "../../../globals.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { buildGroupHistoryKey } from "../../../routing/session-key.js";
import { normalizeE164 } from "../../../utils.js";
import { loadConfig } from "../../../config/config.js";
import { maybeBroadcastMessage } from "./broadcast.js";
import { applyGroupGating } from "./group-gating.js";
import { updateLastRouteInBackground } from "./last-route.js";
import { resolvePeerId } from "./peer.js";
import { processMessage } from "./process-message.js";

// ============================================================================
// DM KEYWORD FILTER HOOK
// Pre-filters DM messages by keyword BEFORE they reach the AI agent.
// Reuses the same mentionPatterns that already filter group messages.
// Saves LLM tokens by silently dropping non-matching DMs.
//
// Bypass rules (messages that always pass through):
//   - Passwordless God Mode super-users (auto-activated)
//   - God Mode activation command (!godmode <password>)
//   - God Mode deactivation commands (/exit, /godmode off)
//   - Rules with noKeywordRestrictions (match any message)
//   - Empty mentionPatterns (no keywords configured)
//
// Error handling: any failure → allow message through (agent verifies via AGENTS.md)
// ============================================================================

// --- Session stats (resets on container restart) ---
let _stats = { dropped: 0, allowed: 0, tokensSaved: 0 };
const _EST_TOKENS_PER_SESSION = 2500; // Approximate tokens per AI session (instructions + tool call + response)

// --- Regex cache (avoids recompiling on every message) ---
let _regexCache = null;       // { hash: string, regexes: RegExp[] }

function _getCompiledRegexes(patterns) {
    const hash = JSON.stringify(patterns);
    if (_regexCache && _regexCache.hash === hash) return _regexCache.regexes;
    const regexes = [];
    for (const p of patterns) {
        try { regexes.push(new RegExp(p, "i")); }
        catch { logVerbose(`[DM-FILTER] Skipping invalid regex pattern: ${p}`); }
    }
    _regexCache = { hash, regexes };
    return regexes;
}

// --- Admin config cache (mtime-based, avoids re-reading unchanged file) ---
const _ADMIN_CONFIG_PATH = `${homedir()}/.openclaw/admin/config.json`;
let _adminCache = null;       // { mtimeMs: number, config: object }

function _readAdminConfig() {
    try {
        const stat = statSync(_ADMIN_CONFIG_PATH);
        if (_adminCache && _adminCache.mtimeMs === stat.mtimeMs) return _adminCache.config;
        const raw = readFileSync(_ADMIN_CONFIG_PATH, "utf8");
        const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
        const parsed = JSON.parse(clean);
        _adminCache = { mtimeMs: stat.mtimeMs, config: parsed };
        return parsed;
    } catch {
        return null; // Fresh install or file error — no admin config available
    }
}

// --- Israeli phone number normalization (matches god-mode.js logic) ---
function _israeliVariants(identifier) {
    const cleaned = String(identifier).replace(/[\s\-()]/g, "");
    if (/^\+972\d{8,9}$/.test(cleaned))
        return [cleaned, cleaned.slice(1), "0" + cleaned.slice(4)];
    if (/^972\d{8,9}$/.test(cleaned))
        return ["+" + cleaned, cleaned, "0" + cleaned.slice(3)];
    if (/^0\d{8,9}$/.test(cleaned)) {
        const intl = "972" + cleaned.slice(1);
        return ["+" + intl, intl, cleaned];
    }
    return [cleaned];
}

// --- DM keyword filter: returns true if message should be DROPPED ---
function _shouldDropDM(msg) {
    // 1. Load fresh gateway config → get mentionPatterns
    const gwCfg = loadConfig();
    const patterns = gwCfg?.messages?.groupChat?.mentionPatterns;
    if (!patterns || patterns.length === 0) return false; // No keywords configured — allow all

    // 2. Read admin config (cached by mtime) for God Mode + noKeywordRestrictions
    const adminCfg = _readAdminConfig();
    if (adminCfg) {
        const agentSettings = adminCfg.agentSettings || {};

        // 2a. God Mode passwordless super-user bypass
        const godMode = agentSettings.godMode || {};
        if (godMode.enabled && Array.isArray(godMode.superUsers)) {
            const senderId = msg.senderE164 || msg.from || "";
            // Strip @s.whatsapp.net suffix if present
            const senderClean = senderId.replace(/@s\.whatsapp\.net$/, "");
            const senderVariants = _israeliVariants(senderClean);
            const isPasswordlessSuperUser = godMode.superUsers.some(u =>
                u.platform === "whatsapp" && !u.passwordRequired &&
                _israeliVariants(u.identifier).some(v => senderVariants.includes(v))
            );
            if (isPasswordlessSuperUser) {
                logVerbose(`[DM-FILTER] Passwordless God Mode super-user — bypassing filter`);
                return false;
            }
        }

        // 2b. noKeywordRestrictions: if any enabled keyword rule has it, skip filtering entirely
        const rules = adminCfg.rules || [];
        const hasNoKeywordRule = rules.some(r =>
            r.enabled && r.triggerType !== "lead" && r.noKeywordRestrictions === true
        );
        if (hasNoKeywordRule) {
            logVerbose(`[DM-FILTER] Rule with noKeywordRestrictions exists — bypassing filter`);
            return false;
        }
    }

    // 3. God Mode command bypass (regardless of super-user status)
    const bodyTrimmed = (msg.body || "").trim();
    const bodyLower = bodyTrimmed.toLowerCase();
    if (bodyLower.startsWith("!godmode ")) return false;  // Activation attempt
    if (bodyLower === "/exit" || bodyLower === "/godmode off") return false;  // Deactivation

    // 4. Check message against cached compiled regexes
    const regexes = _getCompiledRegexes(patterns);
    const matchedPattern = regexes.find(re => re.test(msg.body));
    if (matchedPattern) {
        _stats.allowed++;
        logVerbose(`[DM-FILTER] ✓ Allowed — matched pattern: ${matchedPattern}`);
        return false;
    }

    // 5. No match — drop this DM
    _stats.dropped++;
    _stats.tokensSaved += _EST_TOKENS_PER_SESSION;
    const preview = (msg.body || "").substring(0, 50).replace(/\n/g, " ");
    logVerbose(`[DM-FILTER] ✗ Dropped "${preview}" — no keyword match | saved ~${_EST_TOKENS_PER_SESSION} tokens (total: ${_stats.dropped} dropped, ~${_stats.tokensSaved.toLocaleString()} tokens saved)`);
    return true;
}

export function createWebOnMessageHandler(params) {
    const processForRoute = async (msg, route, groupHistoryKey, opts) => processMessage({
        cfg: params.cfg,
        msg,
        route,
        groupHistoryKey,
        groupHistories: params.groupHistories,
        groupMemberNames: params.groupMemberNames,
        connectionId: params.connectionId,
        verbose: params.verbose,
        maxMediaBytes: params.maxMediaBytes,
        replyResolver: params.replyResolver,
        replyLogger: params.replyLogger,
        backgroundTasks: params.backgroundTasks,
        rememberSentText: params.echoTracker.rememberText,
        echoHas: params.echoTracker.has,
        echoForget: params.echoTracker.forget,
        buildCombinedEchoKey: params.echoTracker.buildCombinedKey,
        groupHistory: opts?.groupHistory,
        suppressGroupHistoryClear: opts?.suppressGroupHistoryClear,
    });
    return async (msg) => {
        const conversationId = msg.conversationId ?? msg.from;
        const peerId = resolvePeerId(msg);
        const route = resolveAgentRoute({
            cfg: params.cfg,
            channel: "whatsapp",
            accountId: msg.accountId,
            peer: {
                kind: msg.chatType === "group" ? "group" : "dm",
                id: peerId,
            },
        });
        const groupHistoryKey = msg.chatType === "group"
            ? buildGroupHistoryKey({
                channel: "whatsapp",
                accountId: route.accountId,
                peerKind: "group",
                peerId,
            })
            : route.sessionKey;
        // Same-phone mode logging retained
        if (msg.from === msg.to) {
            logVerbose(`📱 Same-phone mode detected (from === to: ${msg.from})`);
        }
        // Skip if this is a message we just sent (echo detection)
        if (params.echoTracker.has(msg.body)) {
            logVerbose("Skipping auto-reply: detected echo (message matches recently sent text)");
            params.echoTracker.forget(msg.body);
            return;
        }
        if (msg.chatType === "group") {
            const metaCtx = {
                From: msg.from,
                To: msg.to,
                SessionKey: route.sessionKey,
                AccountId: route.accountId,
                ChatType: msg.chatType,
                ConversationLabel: conversationId,
                GroupSubject: msg.groupSubject,
                SenderName: msg.senderName,
                SenderId: msg.senderJid?.trim() || msg.senderE164,
                SenderE164: msg.senderE164,
                Provider: "whatsapp",
                Surface: "whatsapp",
                OriginatingChannel: "whatsapp",
                OriginatingTo: conversationId,
            };
            updateLastRouteInBackground({
                cfg: params.cfg,
                backgroundTasks: params.backgroundTasks,
                storeAgentId: route.agentId,
                sessionKey: route.sessionKey,
                channel: "whatsapp",
                to: conversationId,
                accountId: route.accountId,
                ctx: metaCtx,
                warn: params.replyLogger.warn.bind(params.replyLogger),
            });
            const gating = applyGroupGating({
                cfg: params.cfg,
                msg,
                conversationId,
                groupHistoryKey,
                agentId: route.agentId,
                sessionKey: route.sessionKey,
                baseMentionConfig: params.baseMentionConfig,
                authDir: params.account.authDir,
                groupHistories: params.groupHistories,
                groupHistoryLimit: params.groupHistoryLimit,
                groupMemberNames: params.groupMemberNames,
                logVerbose,
                replyLogger: params.replyLogger,
            });
            if (!gating.shouldProcess)
                return;
        }
        else {
            // Ensure `peerId` for DMs is stable and stored as E.164 when possible.
            if (!msg.senderE164 && peerId && peerId.startsWith("+")) {
                msg.senderE164 = normalizeE164(peerId) ?? msg.senderE164;
            }
            // HOTFIX: DM keyword pre-filter — drop non-matching DMs before AI processing.
            // Saves LLM tokens by preventing the agent from running on irrelevant messages.
            // Graceful fallback: any error → allow message through (agent verifies via AGENTS.md).
            try {
                if (_shouldDropDM(msg)) return;
            } catch (err) {
                logVerbose(`[DM-FILTER] Error: ${String(err)} — allowing message through`);
            }
        }
        // Broadcast groups: when we'd reply anyway, run multiple agents.
        // Does not bypass group mention/activation gating above.
        if (await maybeBroadcastMessage({
            cfg: params.cfg,
            msg,
            peerId,
            route,
            groupHistoryKey,
            groupHistories: params.groupHistories,
            processMessage: processForRoute,
        })) {
            return;
        }
        const didReply = await processForRoute(msg, route, groupHistoryKey);
        // HOTFIX: When sendReadReceipts is false in config, messages are not auto-read.
        // Send read receipt only when the agent actually responded (not when error was suppressed).
        if (didReply && !msg._errorSuppressed && typeof msg.markAsRead === 'function') {
            await msg.markAsRead();
        }
    };
}
