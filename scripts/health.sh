#!/bin/bash
set -e

# Health check script for Mr Tests Booking
# Usage: ./scripts/health.sh [timeout_seconds]

TIMEOUT=${1:-60}
SITE_URL="https://mr-tests-booking-admin.onrender.com/admin/"
HEALTH_URL="https://mr-tests-booking-admin.onrender.com/health"

echo "🏥 Health check for Mr Tests Booking"
echo "⏱️  Timeout: ${TIMEOUT}s"
echo "🔗 Site: $SITE_URL"

elapsed=0
while (( elapsed < TIMEOUT )); do
    echo -n "Checking... "
    
    # Check main site
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SITE_URL" 2>/dev/null || echo "000")
    
    if [[ "$HTTP_STATUS" == "200" ]]; then
        echo "✅ Site healthy (HTTP: $HTTP_STATUS)"
        
        # Check health endpoint if available
        HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
        if [[ "$HEALTH_STATUS" == "200" ]]; then
            echo "✅ Health endpoint healthy (HTTP: $HEALTH_STATUS)"
        else
            echo "⚠️  Health endpoint unavailable (HTTP: $HEALTH_STATUS)"
        fi
        
        exit 0
    else
        echo "❌ Site unhealthy (HTTP: $HTTP_STATUS)"
    fi
    
    sleep 5
    elapsed=$((elapsed + 5))
done

echo "🚨 Health check failed after ${TIMEOUT}s"
exit 1
