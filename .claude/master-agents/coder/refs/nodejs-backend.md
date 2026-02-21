# Node.js Backend Patterns

## Framework Setup (Express/Fastify)
```typescript
// Express with security middleware
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';

const app = express();
app.use(helmet());                                    // Security headers
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') }));
app.use(compression());                               // Response compression
app.use(express.json({ limit: '10mb' }));             // Body parsing with limit
```

## Error Handling Middleware
```typescript
// Centralized error handler (register LAST)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof AppError) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Async route wrapper (prevents unhandled promise rejections)
const asyncHandler = (fn: Function) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
```

## Architecture Patterns
- **Controller → Service → Repository**: Controllers handle HTTP, services contain logic, repos access data
- **Middleware chain**: auth → validation → rate limit → handler
- **Dependency injection**: Pass dependencies via constructor, not global imports

## Database Integration
- Use connection pooling (pg-pool, mongoose connection pool)
- Parameterized queries ALWAYS (never template literals in SQL)
- Transactions for multi-step operations
- N+1 prevention: batch queries, DataLoader pattern

## Production Checklist
- [ ] Health check endpoint (`GET /health`)
- [ ] Graceful shutdown (SIGTERM handler, drain connections)
- [ ] Structured logging (pino/winston, not console.log)
- [ ] Request ID tracking (correlation IDs)
- [ ] Rate limiting on public endpoints
- [ ] Input validation at route level (zod, joi, class-validator)
- [ ] Environment config via env vars (dotenv for dev only)
