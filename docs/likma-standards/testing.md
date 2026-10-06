# Testing standard

Choose tests from risk, not from a quota:

- Unit tests for deterministic domain rules and transformations.
- Integration tests for database, API, authentication and service boundaries.
- End-to-end tests for critical user journeys.
- Visual checks for product-defining layouts and states.
- Regression tests for every bug that could realistically return.

Every test should state what failure it protects against. A test that only repeats implementation details is weak protection.
