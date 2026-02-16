# Modern JavaScript Patterns (ES6+)

## Destructuring
```javascript
const { name, age, address: { city } } = user;          // Object
const [first, , third, ...rest] = array;                  // Array
const { data: items = [] } = await fetchData();           // Default + rename
```

## Spread/Rest
```javascript
const merged = { ...defaults, ...overrides };             // Object merge
const copy = [...original, newItem];                       // Array copy + append
const { password, ...safeUser } = user;                    // Object rest (omit)
```

## Async Patterns
```javascript
// Prefer async/await over .then chains
const [users, posts] = await Promise.all([fetchUsers(), fetchPosts()]);

// Error handling
try { const data = await fetchData(); }
catch (error) { if (error instanceof NetworkError) { /* retry */ } throw error; }

// Promise.allSettled for independent operations
const results = await Promise.allSettled(urls.map(fetch));
const successful = results.filter(r => r.status === 'fulfilled').map(r => r.value);
```

## Functional Patterns
```javascript
// Pipeline with chaining
const result = data
  .filter(item => item.active)
  .map(item => transform(item))
  .reduce((acc, item) => ({ ...acc, [item.id]: item }), {});

// Optional chaining + nullish coalescing
const city = user?.address?.city ?? 'Unknown';
```

## Modules
```javascript
// Named exports (prefer)
export { fetchUser, createUser };
// Default export (one per file)
export default class UserService {}
// Dynamic import (code splitting)
const { heavy } = await import('./heavy-module.js');
```

## Key Rules
- `const` by default, `let` when reassignment needed, never `var`
- Arrow functions for callbacks, regular functions for methods/constructors
- Template literals over string concatenation
- `for...of` for arrays, `for...in` for object keys (with hasOwnProperty)
- `Map`/`Set` over plain objects when keys are dynamic
