#!/bin/bash
set -e

# Emergency rollback script
# Usage: ./scripts/rollback.sh [commit_hash]

if [ -z "$1" ]; then
    echo "Usage: $0 <commit_hash>"
    echo "Example: $0 abc1234"
    echo ""
    echo "Available recent commits:"
    git log --oneline -10
    exit 1
fi

COMMIT="$1"

echo "🚨 EMERGENCY ROLLBACK"
echo "====================="
echo "Rolling back to: $COMMIT"
echo "Current commit: $(git rev-parse --short HEAD)"
echo ""

# Confirm rollback
read -p "Are you sure? This will reset to commit $COMMIT (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Rollback cancelled"
    exit 1
fi

# Perform rollback
git reset --hard "$COMMIT"
git push --force origin main

echo "✅ Rollback complete!"
echo "🔍 Checking deployment..."
sleep 10
./scripts/health.sh 30
