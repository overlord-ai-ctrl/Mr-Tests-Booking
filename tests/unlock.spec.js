import { test, expect } from '@playwright/test';

test.describe('Admin Unlock Flow', () => {
  test('should unlock and show dashboard when user enters valid code', async ({ page }) => {
    // Track network requests
    const apiRequests = [];
    page.on('request', request => {
      if (request.url().includes('/api/me')) {
        apiRequests.push({
          url: request.url(),
          headers: request.headers(),
          method: request.method()
        });
      }
    });

    // Track console logs
    const consoleLogs = [];
    page.on('console', msg => {
      consoleLogs.push(msg.text());
    });

    // Navigate to admin page
    await page.goto('http://localhost:10000/admin');
    
    // Wait for unlock panel to be visible
    await expect(page.locator('#unlockPanel')).toBeVisible();
    
    // Enter unlock code
    await page.fill('#unlockCode', '1212');
    
    // Click unlock button
    await page.click('#btnUnlock');
    
    // Wait for status to show welcome message
    await expect(page.locator('#unlockStatus')).toContainText('Welcome');
    
    // Wait for jobs tab to be visible (d-none removed)
    await expect(page.locator('#jobs.page')).toBeVisible();
    
    // Verify API request was made with correct headers
    expect(apiRequests.length).toBeGreaterThan(0);
    const meRequest = apiRequests.find(req => req.url.includes('/api/me'));
    expect(meRequest).toBeTruthy();
    expect(meRequest.headers.authorization).toBe('Bearer 1212');
    
    // Verify unlock success console log
    const unlockLog = consoleLogs.find(log => log.includes('[unlock-ok]'));
    expect(unlockLog).toBeTruthy();
    
    // Verify other tabs are loaded (but not necessarily visible)
    await expect(page.locator('#myjobs.page')).toHaveClass(/page/);
    await expect(page.locator('#centres.page')).toHaveClass(/page/);
    await expect(page.locator('#profile.page')).toHaveClass(/page/);
  });

  test('should show error if unlock fails after 2 seconds', async ({ page }) => {
    // Mock API to hang (not respond)
    await page.route('**/api/me', route => {
      // Don't fulfill the request - let it hang
    });

    await page.goto('http://localhost:10000/admin');
    await expect(page.locator('#unlockPanel')).toBeVisible();
    
    await page.fill('#unlockCode', '1212');
    await page.click('#btnUnlock');
    
    // Wait for watchdog error message (after 2 seconds)
    await expect(page.locator('#unlockStatus')).toContainText('Failed to load dashboard after unlock');
  });
});
