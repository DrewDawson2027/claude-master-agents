# E2E Testing Patterns (Playwright/Cypress)

## What to E2E Test
- Critical user journeys: login, signup, checkout, core workflow
- Complex interactions: drag-and-drop, multi-step forms
- Cross-browser compatibility
- Real API integration (not mocked)

## What NOT to E2E Test
- Unit-level logic (use unit tests — faster, cheaper)
- API contracts (use integration tests)
- Edge cases (too slow for E2E)
- Internal implementation details

## Playwright Patterns
```typescript
import { test, expect } from '@playwright/test';

test('user can login and see dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name="email"]', 'user@test.com');
    await page.fill('[name="password"]', 'password');
    await page.click('button[type="submit"]');
    await expect(page.getByText('Dashboard')).toBeVisible();
});
```

## Page Object Model
```typescript
class LoginPage {
    constructor(private page: Page) {}
    async login(email: string, password: string) {
        await this.page.fill('[name="email"]', email);
        await this.page.fill('[name="password"]', password);
        await this.page.click('button[type="submit"]');
    }
}
```

## Anti-Flakiness Rules
- Use `await expect().toBeVisible()` not `waitForTimeout`
- Use `data-testid` only when no semantic selector works
- Isolate test data (each test creates its own, cleans up after)
- Retry on network-dependent assertions
- Run headless in CI, headed for debugging
- Screenshot on failure: `use: { screenshot: 'only-on-failure' }`
