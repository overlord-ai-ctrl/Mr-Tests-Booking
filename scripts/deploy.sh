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

echo "🚀 Deploying from branch: $BRANCH"
echo "📝 Commit message: $COMMIT_MSG"

# Add all changes
git add .

# Commit with message
git commit -m "$COMMIT_MSG"

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
curl -s -I https://mr-tests-booking-admin.onrender.com/admin/ | head -1

echo "🎉 Deployment complete!"
