# Agent prompt: integrate mock-pos

Use this prompt when asking an agentic coding assistant to integrate an application with the local `mock-pos` payment service.

```text
Integrate this application with the mock-pos Docker service for local development and automated tests.

Repository/location of mock-pos: <PATH_OR_GIT_URL>
Target provider(s): <paytr | iyzico | lidio | garanti>
Application runtime and Docker Compose file(s): <DETAILS>

Requirements:

1. Do not call real payment gateways in local/test environments.
2. Configure provider-specific environment variables using the collision-safe base URLs below. Do not use root payment paths.
3. Keep production credentials and production base URLs unchanged; select mock URLs only via local/test configuration.
4. Preserve each provider’s native payload, response, and 3-D redirect/form flow. Do not introduce a generic payment payload unless the application already has an adapter layer.
5. Add or update automated local tests for success, failure, 3-D completion, cancellation, full refund, and partial refund where the application supports them.
6. Add mock-pos as a Docker Compose dependency when the application is Dockerized. Use the Compose service hostname `mock-pos`, not `localhost`, from other containers.
7. Do not add GitHub Actions or other hosted CI configuration. Run relevant tests locally and report the commands/results.
8. Update the application README or local-development documentation with the environment variables and how to run the mock.

Mock service:

- Host machine: http://localhost:8080
- From a sibling Compose service: http://mock-pos:8080
- Health check: GET /health

Provider base URLs (these are the only supported payment entry points):

- PayTR: http://mock-pos:8080/providers/paytr
- iyzico: http://mock-pos:8080/providers/iyzico
- Lidio: http://mock-pos:8080/providers/lidio
- Garanti BBVA: http://mock-pos:8080/providers/garanti

Provider routes:

- PayTR
  - Payment: POST /odeme (form encoded)
  - Refund: POST /odeme/iade (form encoded)
  - Cancellation: POST /odeme/iptal (mock extension; form encoded)
  - 3-D verification code: 123456

- iyzico
  - Non-3D payment: POST /payment/auth (JSON, Authorization starts with `IYZWSv2 `)
  - Start 3-D: POST /payment/3dsecure/initialize
  - Complete 3-D: POST /payment/3dsecure/auth
  - Cancel: POST /payment/cancel
  - Item refund: POST /payment/refund
  - Payment refund: POST /v2/payment/refund
  - 3-D verification code: 123456

- Lidio
  - Non-3D payment: POST /Payment/ProcessPayment (JSON)
  - Start 3-D: POST /Payment/ProcessPayment with `paymentType: "3D"` or `is3DSecure: true`
  - Complete 3-D: POST /Payment/FinishPaymentProcess
  - Cancel: POST /Payment/CancelPayment (mock extension)
  - Refund: POST /Payment/RefundPayment (mock extension)
  - Use `paymentInstrument: "NewCard"` and `paymentInstrumentInfo.newCard`
  - 3-D verification code: 123456

- Garanti BBVA
  - Non-3D payment, cancellation, and refunds: POST /VPServlet (XML)
  - Start 3-D: POST /servlet/gt3dengine (form encoded)
  - For `VPServlet`, use Transaction/Type `sales`, `cancel`, or `refund`; amounts are in kuruş.
  - 3-D OTP: 147852

Test controls:

- Payments succeed by default.
- Card numbers ending in 0000 fail by default.
- Set `X-Mock-Payment-Outcome: failure` or `success` to force a single request outcome.
- Use provider-specific official cards and magic CVVs from mock-pos/TEST_CARDS.md.
- Reversal operations are stateful: create a successful payment first. Partial refunds cannot exceed the original total, and cancellation is rejected after refunds.

Expected implementation output:

- List every changed application file and why it changed.
- Show the exact local/test environment variables added.
- Show the relevant Docker Compose changes, if any.
- Report the local test command(s) run and their result.
- Call out anything unsupported by mock-pos rather than silently routing it to a real gateway.
```

For the full mock contract, consult [README.md](README.md), [TEST_CARDS.md](TEST_CARDS.md), and [docs/ADDING_PROVIDER.md](docs/ADDING_PROVIDER.md).
