# TypeScript Advanced Types

## Generics
```typescript
// Constrained generics
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] { return obj[key]; }

// Generic with default
type ApiResponse<T = unknown> = { data: T; status: number; error?: string };
```

## Conditional Types
```typescript
type IsString<T> = T extends string ? true : false;
type ExtractPromise<T> = T extends Promise<infer U> ? U : T;
type NonNullable<T> = T extends null | undefined ? never : T;
```

## Mapped Types
```typescript
type Readonly<T> = { readonly [K in keyof T]: T[K] };
type Optional<T> = { [K in keyof T]?: T[K] };
type Nullable<T> = { [K in keyof T]: T[K] | null };
```

## Template Literal Types
```typescript
type EventName = `on${Capitalize<string>}`;
type Getter<T extends string> = `get${Capitalize<T>}`;
```

## Utility Types (built-in, use these first)
- `Partial<T>` — all optional
- `Required<T>` — all required
- `Pick<T, K>` — subset of keys
- `Omit<T, K>` — exclude keys
- `Record<K, V>` — key-value map
- `Extract<T, U>` / `Exclude<T, U>` — union filtering
- `ReturnType<F>` — function return type
- `Parameters<F>` — function parameter tuple

## Rules
- Prefer type inference over explicit annotations when clear
- Use `unknown` over `any` — forces type narrowing
- Use `satisfies` for type checking without widening
- Use discriminated unions for state machines: `type State = { status: 'loading' } | { status: 'success'; data: T } | { status: 'error'; error: Error }`
