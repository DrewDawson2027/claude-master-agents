# Async Python Patterns

## Core Concepts
- **Event loop**: single-threaded cooperative multitasking
- **Coroutines**: `async def` functions, paused/resumed with `await`
- **Tasks**: scheduled coroutines running concurrently
- Use async for I/O-bound ops. Use multiprocessing for CPU-bound.

## Concurrency Patterns
```python
import asyncio

# Run multiple coroutines concurrently
async def fetch_all(urls):
    async with aiohttp.ClientSession() as session:
        tasks = [fetch_one(session, url) for url in urls]
        return await asyncio.gather(*tasks, return_exceptions=True)

# Semaphore for rate limiting
sem = asyncio.Semaphore(10)
async def limited_fetch(url):
    async with sem:
        return await fetch(url)

# Timeout
async def fetch_with_timeout(url):
    try:
        return await asyncio.wait_for(fetch(url), timeout=5.0)
    except asyncio.TimeoutError:
        return None
```

## Async Context Managers
```python
class AsyncDBPool:
    async def __aenter__(self):
        self.pool = await create_pool(dsn)
        return self.pool
    async def __aexit__(self, *exc):
        await self.pool.close()
```

## Common Pitfalls
- Never call blocking I/O in async code (use `run_in_executor` for sync libs)
- `asyncio.gather` vs `asyncio.wait`: gather raises on first error, wait gives all results
- Don't forget `await` — missing await returns coroutine object, not result
- Use `asyncio.Queue` for producer/consumer, not shared lists
- Testing: use `pytest-asyncio` with `@pytest.mark.asyncio`

## When to Use
- **Async**: HTTP clients, DB queries, file I/O, WebSockets, web scrapers
- **Threading**: CPU-light I/O, legacy sync library integration
- **Multiprocessing**: CPU-heavy computation, data processing, ML inference
