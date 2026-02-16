# JavaScript/TypeScript Testing Patterns (Jest/Vitest)

## Test Structure
```typescript
describe('UserService', () => {
    let service: UserService;
    beforeEach(() => { service = new UserService(mockDb); });

    it('creates user with valid data', async () => {
        const user = await service.create({ name: 'Alice', email: 'a@test.com' });
        expect(user.name).toBe('Alice');
        expect(user.id).toBeDefined();
    });

    it('throws on duplicate email', async () => {
        await service.create({ name: 'Alice', email: 'a@test.com' });
        await expect(service.create({ name: 'Bob', email: 'a@test.com' }))
            .rejects.toThrow('Email already exists');
    });
});
```

## Mocking
```typescript
// Mock module
jest.mock('./api', () => ({ fetchUser: jest.fn() }));
const { fetchUser } = require('./api') as jest.Mocked<typeof import('./api')>;
fetchUser.mockResolvedValue({ id: '1', name: 'Alice' });

// Spy on method
const spy = jest.spyOn(service, 'validate');
await service.create(data);
expect(spy).toHaveBeenCalledWith(data);
```

## React Testing (Testing Library)
```typescript
import { render, screen, fireEvent } from '@testing-library/react';

test('displays count after click', () => {
    render(<Counter />);
    fireEvent.click(screen.getByRole('button', { name: /increment/i }));
    expect(screen.getByText('Count: 1')).toBeInTheDocument();
});
// Test behavior (what user sees), NOT implementation (component state)
```

## Async Testing
```typescript
it('fetches and displays data', async () => {
    render(<DataList />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Item 1')).toBeInTheDocument());
});
```

## Rules
- Test behavior, not implementation details
- No `getByTestId` if `getByRole`/`getByText` works
- Each test independent, deterministic, fast
- Coverage: 80% branches/lines, 100% on critical paths
- `npm test -- --watchAll=false` for CI
