# Engineering quality standard

- Prefer a simple boundary over clever coupling.
- Keep domain logic independent from UI and infrastructure where practical.
- Validate external input at the boundary.
- Make failure states explicit and observable.
- Use typed contracts for data crossing a module or service boundary.
- Avoid speculative abstractions; extract only after a repeated pattern is clear.
- Treat migrations, permissions and backwards compatibility as first-class changes.
- Keep functions and components small enough to test and explain.
