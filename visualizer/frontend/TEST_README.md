# Testing Documentation - Output Stream Visualization

This document describes the comprehensive test suite for the Output Stream Visualization component.

## Overview

The test suite includes:
- **Unit Tests**: Component-level tests using Vitest and React Testing Library
- **E2E Tests**: Full application tests using Playwright

## Test Structure

```
visualizer/frontend/
├── src/
│   ├── components/
│   │   ├── OutputStreamVisualization.tsx
│   │   └── OutputStreamVisualization.test.tsx    # Unit tests
│   └── test/
│       └── setup.ts                               # Test configuration
├── e2e/
│   └── output-stream.spec.ts                      # E2E tests
├── vitest.config.ts                               # Vitest configuration
└── playwright.config.ts                           # Playwright configuration
```

## Prerequisites

Install test dependencies:

```bash
cd visualizer/frontend
npm install
```

This will install:
- `vitest` - Fast unit test framework
- `@testing-library/react` - React component testing utilities
- `@testing-library/jest-dom` - DOM matchers
- `@playwright/test` - E2E testing framework

## Running Unit Tests

### Run all unit tests:
```bash
npm test
```

### Run tests in watch mode:
```bash
npm test -- --watch
```

### Run tests with UI:
```bash
npm run test:ui
```

### Run tests with coverage:
```bash
npm run test:coverage
```

Coverage report will be generated in `coverage/` directory.

### Run specific test file:
```bash
npm test OutputStreamVisualization.test.tsx
```

### Run tests matching pattern:
```bash
npm test -- --grep "Current Output"
```

## Running E2E Tests

### First-time setup:
```bash
npx playwright install
```

### Run all E2E tests:
```bash
npm run test:e2e
```

### Run E2E tests with UI:
```bash
npm run test:e2e:ui
```

### Run specific browser:
```bash
npx playwright test --project=chromium
npx playwright test --project=firefox
npx playwright test --project=webkit
```

### Run in headed mode (see browser):
```bash
npx playwright test --headed
```

### Debug mode:
```bash
npx playwright test --debug
```

### Run specific test:
```bash
npx playwright test output-stream.spec.ts
```

## Unit Test Coverage

The unit tests cover:

### Component Rendering
- ✓ Renders without crashing
- ✓ Displays "No outputs yet" when empty
- ✓ Shows correct output count
- ✓ Handles singular/plural output text

### Current Output Section
- ✓ Displays CURRENT section header
- ✓ Shows most recent output
- ✓ Displays output metadata
- ✓ Shows pulsing indicator

### History Section
- ✓ Displays HISTORY section header
- ✓ Shows correct history count
- ✓ Hides history with only one output
- ✓ Displays outputs in reverse chronological order

### Vector Display
- ✓ Formats values to 2 decimal places
- ✓ Displays all vector dimensions
- ✓ Handles empty vectors
- ✓ Handles negative values

### Metadata Display
- ✓ Displays metadata description
- ✓ Extracts description from object
- ✓ Handles string metadata
- ✓ Handles missing metadata

### Auto-scroll Behavior
- ✓ Auto-scrolls history when new output arrives

### Styling and Animations
- ✓ Applies different styling to current vs history
- ✓ Includes animation styles

### Edge Cases
- ✓ Handles very long output IDs
- ✓ Handles empty vector arrays
- ✓ Handles large numbers of outputs (100+)
- ✓ Handles negative vector values
- ✓ Handles missing timestamps

### Accessibility
- ✓ Proper semantic structure
- ✓ Text content accessible to screen readers

### Performance
- ✓ Renders efficiently with 1000+ outputs

## E2E Test Coverage

The E2E tests cover:

### Initial State
- ✓ Display output stream panel
- ✓ Show "No outputs yet" message
- ✓ Correct initial count display

### Loading and Displaying Outputs
- ✓ Display outputs after loading machine
- ✓ Show CURRENT section with outputs
- ✓ Show HISTORY section with multiple outputs

### Output Display Format
- ✓ Display vector values in correct format
- ✓ Display output IDs
- ✓ Display metadata when available

### Visual Styling
- ✓ Apply orange gradient to current output
- ✓ Show pulsing indicator

### Scrolling Behavior
- ✓ Enable scrolling with many outputs
- ✓ Keep current output visible when scrolling

### Real-time Updates
- ✓ Update output count
- ✓ Move previous current to history

### Integration with Input Stream
- ✓ Generate outputs from input vectors
- ✓ Show outputs from critical event sequences

### Edge Cases
- ✓ Handle rapid output generation
- ✓ Handle machine switching

### Accessibility
- ✓ Keyboard navigation
- ✓ Visible text content

### Performance
- ✓ Render large numbers without freezing

## Test Data

### Mock Output Vectors
```typescript
{
  id: 'output-1',
  vector: [0.5, 0.25, 0.75],
  timestamp: Date.now(),
  metadata: { description: 'Test output' }
}
```

## Continuous Integration

Tests can be run in CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run unit tests
  run: npm test -- --run

- name: Install Playwright
  run: npx playwright install --with-deps

- name: Run E2E tests
  run: npm run test:e2e
```

## Debugging Tests

### Unit Tests
1. Add `console.log()` statements
2. Use `screen.debug()` to see rendered HTML
3. Use `test.only()` to run specific test
4. Use VS Code debugger with Vitest extension

### E2E Tests
1. Use `--headed` to see browser
2. Use `--debug` for step-by-step debugging
3. Use `page.pause()` to pause execution
4. Check screenshots in `test-results/`
5. View trace files with `npx playwright show-trace`

## Common Issues

### Unit Tests

**Issue**: Tests fail with "Cannot find module"
**Solution**: Ensure all dependencies are installed with `npm install`

**Issue**: Tests timeout
**Solution**: Increase timeout in test file or vitest.config.ts

### E2E Tests

**Issue**: Browser not found
**Solution**: Run `npx playwright install`

**Issue**: Tests fail to connect to server
**Solution**: Ensure dev server is running or let Playwright start it

**Issue**: Flaky tests
**Solution**: Add proper waits with `waitForSelector()` or increase timeouts

## Best Practices

1. **Keep tests isolated**: Each test should be independent
2. **Use data-testid**: Add test IDs for reliable selectors
3. **Mock external dependencies**: Mock API calls in unit tests
4. **Test user interactions**: Focus on user behavior, not implementation
5. **Keep tests readable**: Use descriptive test names
6. **Maintain coverage**: Aim for >80% coverage
7. **Run tests frequently**: Run tests before committing

## Test Maintenance

- Update tests when component API changes
- Add tests for new features
- Remove tests for deprecated features
- Review and refactor tests regularly
- Keep test data up to date

## Performance Benchmarks

### Unit Tests
- Full suite: < 10 seconds
- Single file: < 2 seconds
- 1000 outputs test: < 1 second render time

### E2E Tests
- Full suite: < 5 minutes (all browsers)
- Single browser: < 2 minutes
- Single test: < 30 seconds

## Contributing

When adding new features to OutputStreamVisualization:

1. Add unit tests for new functionality
2. Add E2E tests for user-facing changes
3. Ensure all tests pass
4. Update this documentation
5. Maintain test coverage above 80%

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/react)
- [Playwright Documentation](https://playwright.dev/)
- [Testing Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
