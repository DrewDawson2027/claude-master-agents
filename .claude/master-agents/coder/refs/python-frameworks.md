# Python Web Frameworks — FastAPI + Django

## FastAPI (async-first, API-focused)

**When**: Building APIs, microservices, high-concurrency services

```python
from fastapi import FastAPI, Depends, HTTPException
from pydantic import BaseModel

app = FastAPI()

class UserCreate(BaseModel):
    name: str
    email: str

@app.post("/users", status_code=201)
async def create_user(data: UserCreate, db=Depends(get_db)):
    user = await db.create_user(data)
    return user
```

**Key patterns:**
- Pydantic V2 for all validation/serialization
- Dependency injection via `Depends()` for DB sessions, auth, etc.
- SQLAlchemy 2.0+ with async (`asyncpg`)
- Background tasks: `BackgroundTasks` for simple, Celery for complex
- `Annotated[type, Depends()]` for modern DI (FastAPI 0.100+)

## Django (batteries-included, full-stack)

**When**: Full web apps, admin interfaces, content management

**Key patterns:**
- Django 5.x async views: `async def view(request):`
- DRF for REST APIs: serializers, viewsets, routers
- ORM optimization: `select_related` (FK), `prefetch_related` (M2M)
- Custom user model: ALWAYS use `AbstractUser` from day 1
- Settings: `django-environ` for env vars, split settings for envs

## Shared Best Practices
- Pydantic for validation in both (FastAPI native, Django via DRF serializers)
- Alembic (FastAPI) / Django migrations for schema changes
- Structured logging (structlog/loguru), not print/console
- Health check endpoints for monitoring
- Connection pooling for production (pgbouncer or SQLAlchemy pool)
