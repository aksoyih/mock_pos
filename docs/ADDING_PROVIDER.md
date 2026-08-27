# Adding a payment provider

Each facilitator gets a stable, provider-scoped base URL:

```text
http://mock-pos:8080/providers/<provider-id>
```

This is important because different providers often publish the same endpoint path. For example, a future AcmePay integration using `POST /payment/auth` should configure its base URL as `http://mock-pos:8080/providers/acmepay`; the client will then call `POST /providers/acmepay/payment/auth`. It cannot collide with iyzico’s root-compatible `POST /payment/auth` route.

## Integration checklist

1. Add the provider ID and mount path to `src/providers.js`.
2. Add a provider handler in `src/providers/<provider-id>.js`. Keep validation, endpoint routing, provider response shapes, and test-card rules in that adapter rather than in shared routing.
3. Register the handler in `src/server.js` for the scoped mount. Add root routes only when backward compatibility with that provider requires them.
4. Put official credentials/test-card sources and mock-only scenario controls in `docs/providers/<provider-id>.md`.
5. Add request/response contract tests for every payment mode, error scenario, and a collision test proving `/providers/<provider-id>/payment/auth` is isolated.

Shared code should remain provider-neutral: HTTP helpers, in-memory payment state, generic `X-Mock-Payment-Outcome`, health checks, and Docker configuration. Do not infer a provider from a shared payment request body; the configured base URL is the explicit routing boundary.
