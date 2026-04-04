#!/usr/bin/env bash
# install.sh — Quick install for Nyxo Code

set -e

echo ""
echo "  ◉ Installing Nyxo Code..."
echo ""

# Check node
if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js is required (v16+). Install from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [ "$NODE_VERSION" -lt 16 ]; then
  echo "  ✗ Node.js v16+ required. Current: $(node --version)"
  exit 1
fi

# Install deps
npm install

# Link globally
npm link

echo ""
echo "  ✓ Nyxo Code installed!"
echo ""
echo "  Run:  nyxo config    (set your API key + model)"
echo "  Then: nyxo           (start chatting)"
echo ""
