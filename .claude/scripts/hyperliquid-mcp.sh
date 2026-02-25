#!/bin/bash
# Wrapper to launch hyperliquid MCP with env vars from .env
set -a
source "$(dirname "$0")/../../.env" 2>/dev/null
set +a
exec uvx --from mcp-hyperliquid hyperliquid-mcp
