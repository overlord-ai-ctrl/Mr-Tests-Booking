#!/bin/bash
set -e

# Validation script for Mr Tests Booking
# Usage: ./scripts/validate.sh [--health]

echo "🔍 Running validation checks..."

# Check if we're in the right directory
if [[ ! -f "admin-api/package.json" ]]; then
    echo "❌ Error: Not in Mr Tests Booking root directory"
    exit 1
fi

# Run npm install if needed
if [[ ! -d "admin-api/node_modules" ]]; then
    echo "📦 Installing dependencies..."
    cd admin-api && npm install && cd ..
fi

# Run build check
echo "🔨 Checking build..."
cd admin-api
if npm run build > /dev/null 2>&1; then
    echo "✅ Build successful"
else
    echo "❌ Build failed"
    exit 1
fi
cd ..

# Run lint if available
if grep -q "lint" admin-api/package.json; then
    echo "🧹 Running lint..."
    cd admin-api
    if npm run lint > /dev/null 2>&1; then
        echo "✅ Lint passed"
    else
        echo "⚠️  Lint issues found (continuing...)"
    fi
    cd ..
fi

# Health check if requested
if [[ "$1" == "--health" ]]; then
    echo "🏥 Running health check..."
    ./scripts/health.sh 30
fi

echo "✅ All validation checks passed!"
