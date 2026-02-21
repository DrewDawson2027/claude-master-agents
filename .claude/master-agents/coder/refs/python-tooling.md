# Python Tooling — Packaging, uv, Performance

## uv Package Manager (10-100x faster than pip)
```bash
uv init myproject                    # New project with pyproject.toml
uv add requests pydantic             # Add dependencies
uv add --dev pytest ruff mypy        # Add dev dependencies
uv sync                              # Install from lockfile
uv run pytest                        # Run in project venv
uv python install 3.12               # Install Python version
```
- Drop-in pip replacement: `uv pip install`, `uv pip compile`
- Lockfile: `uv.lock` for reproducible installs
- Global cache: disk-space efficient across projects

## Python Packaging (pyproject.toml)
```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "mypackage"
version = "0.1.0"
dependencies = ["requests>=2.28"]

[project.scripts]
mycli = "mypackage.cli:main"
```
- `src/` layout recommended for libraries
- Build: `uv build` or `python -m build`
- Publish: `uv publish` or `twine upload dist/*`

## Performance Profiling
```python
# CPU profiling
import cProfile
cProfile.run('slow_function()', sort='cumulative')

# Line profiling
# pip install line-profiler
@profile
def slow_function(): ...

# Memory profiling
from memory_profiler import profile
@profile
def memory_heavy(): ...
```

**Optimization strategies (in order):**
1. Better algorithm/data structure (biggest wins)
2. Caching: `functools.lru_cache`, `functools.cache` (Python 3.9+)
3. Avoid copies: generators over lists for large data
4. Async for I/O-bound, multiprocessing for CPU-bound
5. NumPy/Pandas vectorization over Python loops
6. C extensions (Cython, Rust via PyO3) for hot paths — last resort
