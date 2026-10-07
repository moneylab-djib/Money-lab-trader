# Security standard

For every feature, consider:

- authentication and authorisation at the server boundary;
- object-level access control and IDOR;
- validation, injection and unsafe rendering;
- secrets and sensitive logs;
- file uploads, webhooks and rate limits;
- privacy, retention and deletion;
- dependency and supply-chain risk.

Security review is proportional to exposure. A public unauthenticated endpoint and a local display component do not need the same depth, but both need an explicit decision.
