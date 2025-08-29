import { test, expect } from '@playwright/test';

test('debug parent elements', async ({ page }) => {
  // Navigate to admin page
  await page.goto('http://localhost:10000/admin');
  
  // Wait for unlock panel
  await expect(page.locator('#unlockPanel')).toBeVisible();
  
  // Enter code and click unlock
  await page.fill('#unlockCode', '1212');
  await page.click('#btnUnlock');
  
  // Wait for status to show welcome
  await expect(page.locator('#unlockStatus')).toContainText('Welcome');
  
  // Check parent elements
  const parentInfo = await page.locator('#jobs').evaluate(el => {
    const parents = [];
    let current = el.parentElement;
    while (current && parents.length < 5) {
      const computed = window.getComputedStyle(current);
      parents.push({
        tagName: current.tagName,
        id: current.id,
        className: current.className,
        display: computed.display,
        visibility: computed.visibility,
        height: computed.height,
        overflow: computed.overflow,
        position: computed.position
      });
      current = current.parentElement;
    }
    return parents;
  });
  
  console.log('Parent elements:', parentInfo);
  
  // Check if the element is actually in the DOM and visible
  const elementInfo = await page.locator('#jobs').evaluate(el => {
    return {
      offsetParent: el.offsetParent ? el.offsetParent.tagName : null,
      offsetWidth: el.offsetWidth,
      offsetHeight: el.offsetHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight
    };
  });
  
  console.log('Element dimensions:', elementInfo);
  
  // Try to scroll the element into view
  await page.locator('#jobs').scrollIntoViewIfNeeded();
  
  // Check if it's visible after scrolling
  const isVisibleAfterScroll = await page.locator('#jobs').isVisible();
  console.log('Visible after scroll:', isVisibleAfterScroll);
});
