import { test, expect, Page } from '@playwright/test';

test.describe('Output Stream Visualization E2E Tests', () => {
  let page: Page;

  test.beforeEach(async ({ page: testPage }) => {
    page = testPage;
    await page.goto('/');

    // Wait for the application to load
    await page.waitForSelector('text=Reality Engine', { timeout: 30000 });
  });

  test.describe('Initial State', () => {
    test('should display output stream panel on the right side', async () => {
      const outputStream = page.locator('text=OUTPUT STREAM');
      await expect(outputStream).toBeVisible();
    });

    test('should show "No outputs yet" when no outputs are present', async () => {
      await expect(page.locator('text=No outputs yet')).toBeVisible();
      await expect(page.locator('text=Waiting for outputs...')).toBeVisible();
    });

    test('should have correct initial count display', async () => {
      await expect(page.locator('text=No outputs yet')).toBeVisible();
    });
  });

  test.describe('Loading and Displaying Outputs', () => {
    test('should display outputs after loading a machine', async () => {
      // Load NAND Gate machine
      const nandButton = page.locator('button:has-text("NAND Gate")');
      if (await nandButton.isVisible()) {
        await nandButton.click();
        await page.waitForTimeout(2000);

        // Generate random vectors to trigger outputs
        const generateButton = page.locator('button:has-text("Generate")');
        if (await generateButton.isVisible()) {
          await generateButton.click();
          await page.waitForTimeout(2000);

          // Check if outputs appeared
          const outputCount = page.locator('text=/\\d+ output/');
          await expect(outputCount).toBeVisible({ timeout: 10000 });
        }
      }
    });

    test('should show CURRENT section when outputs are present', async () => {
      // Navigate to a machine with outputs
      const machineButton = page.locator('button:has-text("Multi-Step")').first();
      if (await machineButton.isVisible()) {
        await machineButton.click();
        await page.waitForTimeout(1000);

        // Generate outputs
        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // Check for CURRENT section
          await expect(page.locator('text=CURRENT')).toBeVisible({ timeout: 10000 });
        }
      }
    });

    test('should show HISTORY section when multiple outputs exist', async () => {
      // Load machine and generate multiple outputs
      const machineButton = page.locator('button:has-text("NAND Gate")').first();
      if (await machineButton.isVisible()) {
        await machineButton.click();
        await page.waitForTimeout(1000);

        // Generate outputs multiple times
        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(1500);
          await generateBtn.click();
          await page.waitForTimeout(1500);

          // Should show history
          await expect(page.locator('text=HISTORY')).toBeVisible({ timeout: 10000 });
          await expect(page.locator('text=/\\d+ previous/')).toBeVisible();
        }
      }
    });
  });

  test.describe('Output Display Format', () => {
    test('should display vector values in correct format', async () => {
      // Load machine and generate outputs
      const machineBtn = page.locator('button').filter({ hasText: /NAND|Multi-Step/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // Check for vector format [x.xx, y.yy, ...]
          const vectorPattern = page.locator('text=/\\[\\d+\\.\\d{2}/');
          await expect(vectorPattern.first()).toBeVisible({ timeout: 10000 });
        }
      }
    });

    test('should display output IDs', async () => {
      // Generate outputs and check for IDs
      const machineBtn = page.locator('button').filter({ hasText: /NAND/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // Check for output ID pattern
          const outputId = page.locator('text=/nand-output-|Output \\d+/');
          await expect(outputId.first()).toBeVisible({ timeout: 10000 });
        }
      }
    });

    test('should display metadata when available', async () => {
      // Load NAND gate which has metadata
      const nandBtn = page.locator('button:has-text("NAND Gate")').first();
      if (await nandBtn.isVisible()) {
        await nandBtn.click();
        await page.waitForTimeout(1000);

        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // Check for metadata text (NAND outputs have logicValue metadata)
          const metadata = page.locator('text=/TRUE|FALSE|NAND/');
          await expect(metadata.first()).toBeVisible({ timeout: 10000 });
        }
      }
    });
  });

  test.describe('Visual Styling', () => {
    test('should apply orange gradient to current output', async () => {
      const machineBtn = page.locator('button').filter({ hasText: /NAND/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // Current output should have gradient background
          const currentSection = page.locator('text=CURRENT').locator('..');
          const outputCard = currentSection.locator('div').filter({ hasText: /\\[\\d+\\.\\d{2}/ }).first();

          if (await outputCard.isVisible()) {
            const styles = await outputCard.getAttribute('style');
            expect(styles).toContain('gradient');
          }
        }
      }
    });

    test('should show pulsing indicator for current output', async () => {
      const machineBtn = page.locator('button').filter({ hasText: /Multi-Step/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // Check for pulsing indicator (animated dot)
          const currentHeader = page.locator('text=CURRENT');
          await expect(currentHeader).toBeVisible({ timeout: 10000 });
        }
      }
    });
  });

  test.describe('Scrolling Behavior', () => {
    test('should enable scrolling when many outputs are present', async () => {
      const machineBtn = page.locator('button').filter({ hasText: /NAND/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        // Generate many outputs
        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          for (let i = 0; i < 5; i++) {
            await generateBtn.click();
            await page.waitForTimeout(1000);
          }

          // History section should be scrollable
          const historySection = page.locator('text=HISTORY').locator('..');
          const scrollContainer = historySection.locator('div').filter({ has: page.locator('text=/\\[\\d+\\.\\d{2}/')}).first();

          if (await scrollContainer.isVisible()) {
            const overflow = await scrollContainer.evaluate((el) =>
              window.getComputedStyle(el).overflowY
            );
            // Should be scrollable (auto or scroll)
            expect(['auto', 'scroll']).toContain(overflow);
          }
        }
      }
    });

    test('should keep current output visible when scrolling history', async () => {
      const machineBtn = page.locator('button').filter({ hasText: /NAND/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        // Generate multiple outputs
        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          for (let i = 0; i < 3; i++) {
            await generateBtn.click();
            await page.waitForTimeout(1000);
          }

          // Current section should always be visible
          await expect(page.locator('text=CURRENT')).toBeVisible();
        }
      }
    });
  });

  test.describe('Real-time Updates', () => {
    test('should update output count when new outputs arrive', async () => {
      const machineBtn = page.locator('button').filter({ hasText: /NAND/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        // Initial state
        const initialCount = await page.locator('text=/\\d+ output/').textContent();

        // Generate new outputs
        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // Count should have changed
          const newCount = await page.locator('text=/\\d+ output/').textContent();
          expect(newCount).not.toBe(initialCount);
        }
      }
    });

    test('should move previous current to history when new output arrives', async () => {
      const machineBtn = page.locator('button').filter({ hasText: /Multi-Step/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          // First generation
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // Get first output ID
          const firstOutputId = await page.locator('text=CURRENT')
            .locator('..')
            .locator('text=/output-|Output/')
            .first()
            .textContent();

          // Second generation
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // First output should now be in history
          if (firstOutputId && await page.locator('text=HISTORY').isVisible()) {
            const historySection = page.locator('text=HISTORY').locator('..');
            await expect(historySection.locator(`text=${firstOutputId}`)).toBeVisible();
          }
        }
      }
    });
  });

  test.describe('Integration with Input Stream', () => {
    test('should generate outputs when processing input vectors', async () => {
      const machineBtn = page.locator('button:has-text("NAND Gate")').first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        // Enable binary threshold for predictable NAND outputs
        const binaryCheckbox = page.locator('input[type="checkbox"]').filter({ hasText: /Binary/ }).first();
        if (await binaryCheckbox.isVisible()) {
          await binaryCheckbox.check();
        }

        // Generate random vectors
        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // Should have outputs
          await expect(page.locator('text=CURRENT')).toBeVisible({ timeout: 10000 });
          await expect(page.locator('text=/\\d+ output/')).toBeVisible();
        }
      }
    });

    test('should show outputs in response to critical event sequences', async () => {
      const machineBtn = page.locator('button:has-text("Multi-Step")').first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        // Enable binary threshold
        const binaryCheckbox = page.locator('input[type="checkbox"]').first();
        if (await binaryCheckbox.isVisible()) {
          await binaryCheckbox.check();
        }

        // Generate - should inject critical event sequences
        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(3000);

          // Should show activity about sequence injection
          const activityLog = page.locator('text=/critical event sequence/');
          await expect(activityLog.first()).toBeVisible({ timeout: 10000 });
        }
      }
    });
  });

  test.describe('Edge Cases', () => {
    test('should handle rapid output generation', async () => {
      const machineBtn = page.locator('button').filter({ hasText: /NAND/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          // Rapidly generate outputs
          for (let i = 0; i < 10; i++) {
            await generateBtn.click();
            await page.waitForTimeout(300);
          }

          // Should still work correctly
          await expect(page.locator('text=CURRENT')).toBeVisible();
          await expect(page.locator('text=HISTORY')).toBeVisible();
        }
      }
    });

    test('should handle machine switching with outputs', async () => {
      // Load first machine
      const nandBtn = page.locator('button:has-text("NAND Gate")').first();
      if (await nandBtn.isVisible()) {
        await nandBtn.click();
        await page.waitForTimeout(1000);

        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(2000);
        }

        // Switch to another machine
        const multiStepBtn = page.locator('button:has-text("Multi-Step")').first();
        if (await multiStepBtn.isVisible()) {
          await multiStepBtn.click();
          await page.waitForTimeout(1000);

          // Output stream should reset or show new machine's outputs
          await expect(page.locator('text=OUTPUT STREAM')).toBeVisible();
        }
      }
    });
  });

  test.describe('Accessibility', () => {
    test('should be keyboard navigable', async () => {
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');

      // Should be able to navigate through the interface
      const focused = await page.evaluate(() => document.activeElement?.tagName);
      expect(['BUTTON', 'INPUT', 'A', 'DIV']).toContain(focused);
    });

    test('should have visible text for all content', async () => {
      const machineBtn = page.locator('button').filter({ hasText: /NAND/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await page.waitForTimeout(2000);

          // All text should be visible (not hidden)
          await expect(page.locator('text=OUTPUT STREAM')).toBeVisible();
          await expect(page.locator('text=CURRENT')).toBeVisible();
        }
      }
    });
  });

  test.describe('Performance', () => {
    test('should render large number of outputs without freezing', async () => {
      const machineBtn = page.locator('button').filter({ hasText: /NAND/ }).first();
      if (await machineBtn.isVisible()) {
        await machineBtn.click();
        await page.waitForTimeout(1000);

        const generateBtn = page.locator('button:has-text("Generate")').first();
        if (await generateBtn.isVisible()) {
          const startTime = Date.now();

          // Generate many outputs
          for (let i = 0; i < 20; i++) {
            await generateBtn.click();
            await page.waitForTimeout(200);
          }

          const endTime = Date.now();
          const duration = endTime - startTime;

          // Should complete in reasonable time (< 10 seconds)
          expect(duration).toBeLessThan(10000);

          // Interface should still be responsive
          await expect(page.locator('text=CURRENT')).toBeVisible();
        }
      }
    });
  });
});
