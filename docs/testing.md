# Testing Strategy

> Testing approach, standards, and procedures.

## Overview

(Describe the overall testing philosophy for this project)

## Test Types

### Unit Tests

- **Location**: `tests/unit/`
- **Framework**: (pytest / Jest / etc.)
- **Coverage Target**: (e.g., 80%)

### Integration Tests

- **Location**: `tests/integration/`
- **Framework**:
- **Scope**:

### End-to-End Tests

- **Location**: `tests/e2e/`
- **Framework**: (Playwright / Cypress / etc.)
- **Scope**:

## Running Tests

### All Tests

```bash
# Python
pytest

# Node.js
npm test
```

### Specific Test Suite

```bash
# Python
pytest tests/unit/
pytest tests/integration/

# Node.js
npm run test:unit
npm run test:e2e
```

### With Coverage

```bash
# Python
pytest --cov=src --cov-report=html

# Node.js
npm run test:coverage
```

## Test Naming Conventions

```python
# Python
def test_function_name_should_expected_behavior_when_condition():
    pass

# Example
def test_calculate_total_should_return_sum_when_valid_items():
    pass
```

```javascript
// JavaScript/TypeScript
describe('ComponentName', () => {
  it('should expected behavior when condition', () => {
    // ...
  });
});
```

## Mocking Guidelines

- (Describe when and how to use mocks)
- (List common mocking patterns)

## CI/CD Integration

- Tests run automatically on:
  - [ ] Pull requests
  - [ ] Main branch commits
  - [ ] Scheduled (nightly)

---

*Last updated: YYYY-MM-DD*
