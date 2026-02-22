#!/bin/bash
set -e

cd /Users/johanthorell/Documents/Development/ai-assistant

# Ensure common user-level bin paths are available in launchd context.
export PATH="/Users/johanthorell/.npm-global/bin:/Users/johanthorell/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Source environment variables
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# Run the bot
BUN_BIN="$(command -v bun)"
if [ -z "$BUN_BIN" ]; then
    echo "bun not found in PATH: $PATH" >&2
    exit 1
fi
exec "$BUN_BIN" run src/index.ts
