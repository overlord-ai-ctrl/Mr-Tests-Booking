#!/bin/bash
set -e

# Stuck Report Generator
# Usage: ./scripts/stuck-report.sh "step" "error" "hypothesis"

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 \"step\" \"error\" \"hypothesis\""
    echo "Example: $0 \"git push\" \"fatal: not a git repo\" \"Wrong directory\""
    exit 1
fi

STEP="$1"
ERROR="$2"
HYPOTHESIS="${3:-Unknown issue}"

echo "🚨 STUCK REPORT"
echo "================"
echo "Where stuck: $STEP"
echo "Exact error: $ERROR"
echo "Hypothesis: $HYPOTHESIS"
echo ""
echo "Tried:"
echo "- Current directory: $(pwd)"
echo "- Git status: $(git status --porcelain 2>/dev/null | wc -l) changes"
echo "- Branch: $(git branch --show-current 2>/dev/null || echo 'unknown')"
echo "- Last commit: $(git log -1 --oneline 2>/dev/null || echo 'none')"
echo ""
echo "Blockers:"
echo "- Check if in correct directory"
echo "- Verify git repository exists"
echo "- Check network connectivity"
echo ""
echo "Top 3 options:"
echo "1) Check directory and git status (ETA: 1min)"
echo "2) Reset and retry (ETA: 2min)"
echo "3) Ask user for guidance (ETA: unknown)"
echo ""
echo "I recommend: 1"
