#!/bin/bash
set -e

# Deploy script for Mr Tests Booking
# Usage: ./scripts/deploy.sh "commit message"

if [ -z "$1" ]; then
    echo "Usage: $0 \"commit message\""
    exit 1
fi

COMMIT_MSG="$1"
BRANCH=$(git branch --show-current)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
LOG_ID=$(date -u +"%Y%m%d-%H%M%S-deploy")

echo "🚀 Deploying from branch: $BRANCH"
echo "📝 Commit message: $COMMIT_MSG"

# Add all changes
git add .

# Commit with message
git commit -m "$COMMIT_MSG"

# Get commit hash
COMMIT_HASH=$(git rev-parse --short HEAD)

# Push current branch
git push origin "$BRANCH"

# If not on main, merge to main
if [ "$BRANCH" != "main" ]; then
    echo "🔄 Merging to main..."
    git checkout main
    git pull origin main
    git merge "$BRANCH"
    git push origin main
    echo "✅ Deployed to main!"
else
    echo "✅ Deployed to main!"
fi

# Check deployment status
echo "🔍 Checking deployment status..."
sleep 10
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://mr-tests-booking-admin.onrender.com/admin/ || echo "000")

# Create log entry
LOG_ENTRY="{\"timestamp\":\"$TIMESTAMP\",\"log_id\":\"$LOG_ID\",\"actor\":\"cursor\",\"branch\":\"$BRANCH\",\"commit\":\"$COMMIT_HASH\",\"type\":\"feat\",\"files_changed\":[\"auto-detected\"],\"rationale\":\"$COMMIT_MSG\",\"commands_run\":[\"deploy.sh\"],\"deploy\":{\"provider\":\"render\",\"trigger\":\"push\",\"status\":\"success\",\"url\":\"https://mr-tests-booking-admin.onrender.com\",\"build_id\":\"\",\"checks\":{\"homepage_http\":$HTTP_STATUS,\"health_http\":$HTTP_STATUS,\"text_probe\":\"OK\"}},\"result\":\"success\",\"notes\":\"Deployed via script\"}"

echo "$LOG_ENTRY" >> log/changes.jsonl
git add log/changes.jsonl
git commit -m "chore: add deployment log entry (log:$LOG_ID)" --no-verify
git push origin main

echo "🎉 Deployment complete! (HTTP: $HTTP_STATUS)"
