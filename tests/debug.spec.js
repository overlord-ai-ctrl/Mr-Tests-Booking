import { test, expect } from '@playwright/test';

test('debug unlock flow', async ({ page }) => {
  // Track console logs
  const consoleLogs = [];
  page.on('console', msg => {
    consoleLogs.push(msg.text());
    console.log('Console:', msg.text());
  });

  // Navigate to admin page
  await page.goto('http://localhost:10000/admin');
  
  // Wait for unlock panel
  await expect(page.locator('#unlockPanel')).toBeVisible();
  
  // Check initial state
  const jobsTab = page.locator('#jobs');
  console.log('Initial jobs tab classes:', await jobsTab.getAttribute('class'));
  
  // Enter code and click unlock
  await page.fill('#unlockCode', '1212');
  await page.click('#btnUnlock');
  
  // Wait a bit
  await page.waitForTimeout(1000);
  
  // Check status
  const status = await page.locator('#unlockStatus').textContent();
  console.log('Status:', status);
  
  // Check jobs tab classes again
  console.log('After unlock jobs tab classes:', await jobsTab.getAttribute('class'));
  
  // Check if jobs tab is visible
  const isVisible = await jobsTab.isVisible();
  console.log('Jobs tab visible:', isVisible);
  
  // Print all console logs
  console.log('All console logs:', consoleLogs);
});
