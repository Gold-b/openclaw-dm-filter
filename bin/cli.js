#!/usr/bin/env node
// openclaw-dm-filter — DM keyword pre-filter for OpenClaw gateway
// Copyright (c) 2026 Or Goldberg (aka Gold-B). MIT License. https://github.com/Gold-b/openclaw-dm-filter
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PATCH_NAME = 'on-message-hotfix.js';
const PATCHES_DIR = path.join(os.homedir(), '.openclaw', 'patches');
const PATCH_SOURCE = path.join(__dirname, '..', 'patch', PATCH_NAME);
const PATCH_TARGET = path.join(PATCHES_DIR, PATCH_NAME);
const BACKUP_TARGET = path.join(PATCHES_DIR, PATCH_NAME + '.backup');

// Docker-compose entrypoint command that applies the patch
const ENTRYPOINT_CMD = 'cp /home/node/.openclaw/patches/on-message-hotfix.js /app/dist/web/auto-reply/monitor/on-message.js 2>/dev/null || true';

function printHelp() {
  console.log(`
  openclaw-dm-filter — DM keyword pre-filter for OpenClaw gateway

  USAGE:
    npx openclaw-dm-filter install     Install the DM keyword filter patch
    npx openclaw-dm-filter uninstall   Restore from backup (if available)
    npx openclaw-dm-filter status      Check installation status
    npx openclaw-dm-filter help        Show this help message

  WHAT IT DOES:
    Filters incoming WhatsApp DMs by keyword BEFORE they reach the AI agent.
    Non-matching DMs are silently dropped, saving LLM tokens and money.
    Uses the same mentionPatterns that already filter group messages.

  REQUIREMENTS:
    - OpenClaw gateway running in Docker
    - Keywords configured in openclaw.json (via admin panel or manually)
    - Docker-compose entrypoint must copy patches on startup
`);
}

function install() {
  console.log('\n  Installing DM keyword filter...\n');

  // Verify source patch exists
  if (!fs.existsSync(PATCH_SOURCE)) {
    console.error('  ERROR: Patch file not found at', PATCH_SOURCE);
    process.exit(1);
  }

  // Create patches directory if needed
  if (!fs.existsSync(PATCHES_DIR)) {
    fs.mkdirSync(PATCHES_DIR, { recursive: true });
    console.log('  Created:', PATCHES_DIR);
  }

  // Backup existing patch (if any)
  if (fs.existsSync(PATCH_TARGET)) {
    fs.copyFileSync(PATCH_TARGET, BACKUP_TARGET);
    console.log('  Backed up existing patch to:', PATCH_NAME + '.backup');
  }

  // Copy patch
  fs.copyFileSync(PATCH_SOURCE, PATCH_TARGET);
  console.log('  Installed patch to:', PATCH_TARGET);

  console.log(`
  DONE! Next steps:

  1. Ensure your docker-compose.yml entrypoint includes this copy command:

     ${ENTRYPOINT_CMD}

  2. Restart the gateway container:

     docker compose down && docker compose up -d

  3. Configure keywords in your admin panel or openclaw.json:

     "messages": {
       "groupChat": {
         "mentionPatterns": ["keyword1", "keyword2", "regex.*pattern"]
       }
     }

  4. Send a DM to your bot — non-matching messages will be silently dropped.
     Check gateway logs (docker logs goldb-gateway) for [DM-FILTER] entries.
`);
}

function uninstall() {
  console.log('\n  Uninstalling DM keyword filter...\n');

  if (fs.existsSync(BACKUP_TARGET)) {
    fs.copyFileSync(BACKUP_TARGET, PATCH_TARGET);
    fs.unlinkSync(BACKUP_TARGET);
    console.log('  Restored original patch from backup.');
  } else if (fs.existsSync(PATCH_TARGET)) {
    fs.unlinkSync(PATCH_TARGET);
    console.log('  Removed patch (no backup found).');
  } else {
    console.log('  Nothing to uninstall — patch not found.');
    return;
  }

  console.log('\n  Restart the gateway to apply: docker compose down && docker compose up -d\n');
}

function status() {
  console.log('\n  DM Keyword Filter Status:\n');

  const patchExists = fs.existsSync(PATCH_TARGET);
  const backupExists = fs.existsSync(BACKUP_TARGET);
  const patchesDir = fs.existsSync(PATCHES_DIR);

  console.log('  Patches directory:', patchesDir ? 'EXISTS' : 'MISSING');
  console.log('  Patch installed:  ', patchExists ? 'YES' : 'NO');
  console.log('  Backup available: ', backupExists ? 'YES' : 'NO');

  if (patchExists) {
    // Check if the installed patch contains the DM filter
    const content = fs.readFileSync(PATCH_TARGET, 'utf8');
    const hasDmFilter = content.includes('_shouldDropDM');
    console.log('  DM filter active: ', hasDmFilter ? 'YES' : 'NO (patch exists but missing DM filter)');
  }

  // Check openclaw.json for mentionPatterns
  const ocPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  if (fs.existsSync(ocPath)) {
    try {
      const raw = fs.readFileSync(ocPath, 'utf8');
      const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      const cfg = JSON.parse(clean);
      const patterns = cfg?.messages?.groupChat?.mentionPatterns || [];
      console.log('  Keyword patterns: ', patterns.length > 0 ? `${patterns.length} configured` : 'NONE (filter will be a no-op)');
    } catch {
      console.log('  Keyword patterns:  Could not read openclaw.json');
    }
  } else {
    console.log('  Keyword patterns:  openclaw.json not found');
  }

  console.log('');
}

// Parse command
const command = process.argv[2] || 'help';

switch (command) {
  case 'install':
    install();
    break;
  case 'uninstall':
  case 'remove':
    uninstall();
    break;
  case 'status':
    status();
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    console.error(`  Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
