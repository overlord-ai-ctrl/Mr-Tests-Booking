import { test, expect } from '@playwright/test';

test('debug unlock flow detailed', async ({ page }) => {
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
  console.log('Initial jobs tab computed style display:', await jobsTab.evaluate(el => window.getComputedStyle(el).display));
  
  // Enter code and click unlock
  await page.fill('#unlockCode', '1212');
  await page.click('#btnUnlock');
  
  // Wait for status to show welcome
  await expect(page.locator('#unlockStatus')).toContainText('Welcome');
  
  // Check jobs tab classes and styles after unlock
  console.log('After unlock jobs tab classes:', await jobsTab.getAttribute('class'));
  console.log('After unlock jobs tab computed style display:', await jobsTab.evaluate(el => window.getComputedStyle(el).display));
  console.log('After unlock jobs tab computed style visibility:', await jobsTab.evaluate(el => window.getComputedStyle(el).visibility));
  
  // Check if jobs tab is visible
  const isVisible = await jobsTab.isVisible();
  console.log('Jobs tab visible:', isVisible);
  
  // Check if jobs tab is in viewport
  const isInViewport = await jobsTab.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  console.log('Jobs tab has dimensions:', isInViewport);
  
  // Check the actual content
  const content = await jobsTab.textContent();
  console.log('Jobs tab content:', content);
  
  // Print all console logs
  console.log('All console logs:', consoleLogs);
});
