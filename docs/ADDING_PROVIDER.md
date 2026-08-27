# Adding a payment provider

Each facilitator has a stable Laravel route mount:

```text
/providers/<provider-id>
```

The optional `MOCK_POS_ROUTE_PREFIX` config value is prepended to this path. Provider scoping prevents published endpoint collisions: a future AcmePay client calling `/payment/auth` is mounted as `/providers/acmepay/payment/auth`, isolated from `/providers/iyzico/payment/auth`.

## Integration checklist

1. Add the provider's route dispatch to `MockPosController::handle`.
2. Keep request validation, endpoint routing, response shapes, and test-card rules in dedicated provider methods (extract a provider class when the adapter grows).
3. Do not register unscoped root payment routes.
4. Document official credentials/test cards and mock-only controls in `docs/providers/<provider-id>.md`.
5. Add Laravel Testbench request/response contract tests for success, failure, 3-D completion, reversals, and route isolation.

Shared package code should remain provider-neutral: the service provider, route-prefix config, in-memory `PaymentStore`, generic `X-Mock-Payment-Outcome` control, and health check. Do not infer a provider from a payment request body; the configured base URL is the routing boundary.
