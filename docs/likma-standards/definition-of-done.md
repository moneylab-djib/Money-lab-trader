# Definition of done
Select applicable gates before implementation. Completion is evidence scaled to risk.

| Change | Minimum evidence |
| --- | --- |
| Copy/styling | Correct content, viewport and state inspection |
| Domain logic | Behaviour and edge tests, configured types/lint checks |
| API/database/auth | Boundary and denied-access tests, recovery analysis |
| Payments/uploads | Abuse paths, retries, duplicates, permission review |
| Release | Build, staging smoke, monitoring and rollback evidence |

Cover real loading, empty, failure and permission states. Run relevant project checks and regression tests.
Missing tooling blocks claims of verification. Explain skipped checks and consequences.
Distinguish legacy failures from new failures. Never disable tests or suppress errors to claim success.
Update status and contracts. Do not add ceremony for a trivial reversible edit.
