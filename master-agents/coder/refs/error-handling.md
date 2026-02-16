# Error Handling Patterns

## Philosophy
- **Exceptions**: unexpected errors, exceptional conditions
- **Result types**: expected errors, validation failures
- **Fail fast**: validate input early, fail quickly
- **Handle at right level**: catch where you can meaningfully respond

## Python Patterns
```python
# Custom exception hierarchy
class AppError(Exception):
    def __init__(self, message, code=None, details=None):
        super().__init__(message)
        self.code, self.details = code, details or {}

class ValidationError(AppError): pass
class NotFoundError(AppError): pass
class ExternalServiceError(AppError):
    def __init__(self, message, service, **kwargs):
        super().__init__(message, **kwargs)
        self.service = service

# Context manager for cleanup
@contextmanager
def db_transaction(session):
    try:
        yield session; session.commit()
    except: session.rollback(); raise
    finally: session.close()

# Retry with backoff: max_attempts=3, backoff_factor=2.0, catch specific exceptions
```

## TypeScript Patterns
```typescript
// Result type for explicit error handling
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

// Custom errors with status codes
class AppError extends Error {
    constructor(message: string, public code: string, public statusCode = 500) {
        super(message); this.name = this.constructor.name;
    }
}
```

## Rules
1. Never catch too broadly (`except:` / `catch(e)` without specifics)
2. Never swallow errors silently (empty catch blocks = ALWAYS flag)
3. Never log AND re-throw (creates duplicate entries) — pick one
4. Always clean up resources (try-finally, context managers, defer)
5. Error messages: explain what happened AND how to fix it
