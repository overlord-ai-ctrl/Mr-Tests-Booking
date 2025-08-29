import { test, expect } from '@playwright/test';

test('debug CSS styles', async ({ page }) => {
  // Navigate to admin page
  await page.goto('http://localhost:10000/admin');
  
  // Wait for unlock panel
  await expect(page.locator('#unlockPanel')).toBeVisible();
  
  // Enter code and click unlock
  await page.fill('#unlockCode', '1212');
  await page.click('#btnUnlock');
  
  // Wait for status to show welcome
  await expect(page.locator('#unlockStatus')).toContainText('Welcome');
  
  // Check all computed styles for the jobs tab
  const styles = await page.locator('#jobs').evaluate(el => {
    const computed = window.getComputedStyle(el);
    return {
      display: computed.display,
      visibility: computed.visibility,
      height: computed.height,
      minHeight: computed.minHeight,
      padding: computed.padding,
      background: computed.background,
      border: computed.border,
      borderRadius: computed.borderRadius,
      boxShadow: computed.boxShadow,
      width: computed.width,
      position: computed.position,
      top: computed.top,
      left: computed.left,
      zIndex: computed.zIndex
    };
  });
  
  console.log('Jobs tab computed styles:', styles);
  
  // Check if the element has any content
  const hasContent = await page.locator('#jobs').evaluate(el => {
    return el.children.length > 0 || el.textContent.trim().length > 0;
  });
  
  console.log('Jobs tab has content:', hasContent);
  
  // Check the bounding box
  const boundingBox = await page.locator('#jobs').boundingBox();
  console.log('Jobs tab bounding box:', boundingBox);
});
