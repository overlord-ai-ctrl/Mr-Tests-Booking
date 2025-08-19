#!/bin/bash
set -e

# Quick feature branch script
# Usage: ./scripts/feature.sh "feature-name" "description"

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 \"feature-name\" \"description\""
    echo "Example: $0 \"ui-polish\" \"Improve button styling\""
    exit 1
fi

FEATURE_NAME="$1"
DESCRIPTION="$2"
BRANCH_NAME="feat/$FEATURE_NAME"

echo "🚀 Creating feature branch: $BRANCH_NAME"
echo "📝 Description: $DESCRIPTION"

# Ensure we're on main and up to date
git checkout main
git pull origin main

# Create and switch to new branch
git checkout -b "$BRANCH_NAME"

echo "✅ Created branch: $BRANCH_NAME"
echo "💡 Start coding! When ready, run: ./scripts/deploy.sh \"$DESCRIPTION\""
