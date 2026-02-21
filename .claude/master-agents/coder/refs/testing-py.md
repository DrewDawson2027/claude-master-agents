# Python Testing Patterns (pytest)

## Test Structure (AAA)
```python
def test_create_user():
    # Arrange
    data = {"name": "Alice", "email": "alice@test.com"}
    # Act
    user = create_user(data)
    # Assert
    assert user.name == "Alice"
    assert user.email == "alice@test.com"
```

## Fixtures
```python
@pytest.fixture
def db_session():
    session = create_test_session()
    yield session
    session.rollback(); session.close()

@pytest.fixture
def sample_user(db_session):
    user = User(name="Test", email="test@test.com")
    db_session.add(user); db_session.flush()
    return user
```

## Parametrize
```python
@pytest.mark.parametrize("input,expected", [
    ("valid@email.com", True),
    ("invalid", False),
    ("", False),
    (None, False),
])
def test_validate_email(input, expected):
    assert validate_email(input) == expected
```

## Mocking
```python
from unittest.mock import patch, MagicMock

@patch("myapp.services.external_api.fetch")
def test_with_mock(mock_fetch):
    mock_fetch.return_value = {"status": "ok"}
    result = process_data()
    mock_fetch.assert_called_once()
    assert result.status == "ok"
```

## Async Testing
```python
import pytest

@pytest.mark.asyncio
async def test_async_fetch():
    result = await fetch_data("test-id")
    assert result is not None
```

## Rules
- Test behavior, not implementation
- Each test independent (no shared mutable state)
- Descriptive names: `test_create_user_with_duplicate_email_raises_error`
- Coverage target: >80% lines, 100% on critical paths
- `pytest -x -q --tb=short` for fast feedback
