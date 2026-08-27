# mock-pos

A Docker-ready local mock for the payment endpoints used by [PayTR Direct API](https://dev.paytr.com/en/direkt-api/direkt-api-1-adim) and [iyzico payments](https://docs.iyzico.com/en/getting-started/preliminaries/api-reference-beta/payment-methods/api-non3d). It deliberately implements only card payments: 3-D Secure and non-3D.

It is intended for integration and end-to-end tests in Dockerized applications. It is not a payment gateway and must never be exposed as a production payment endpoint.

## Run it

Start the service:

```sh
docker compose up --build
```

The service listens at `http://localhost:8080`. From a sibling Compose service, use `http://mock-pos:8080` (add both services to the same Compose network). Health check:

```sh
curl http://localhost:8080/health
```

For a local Node process, run `npm start`. No runtime npm packages are required.

## Provider base URLs

Provider-scoped URLs are the only payment API surface. They prevent endpoint collisions between facilitators:

| Provider | Base URL |
| --- | --- |
| PayTR | `http://mock-pos:8080/providers/paytr` |
| iyzico | `http://mock-pos:8080/providers/iyzico` |
| Lidio | `http://mock-pos:8080/providers/lidio` |

For example, an iyzico client calling `/payment/auth` uses base URL `http://mock-pos:8080/providers/iyzico`, producing `POST /providers/iyzico/payment/auth`. Root payment paths such as `/payment/auth` and `/odeme` intentionally return `404`. A future provider with that same endpoint must be mounted at `http://mock-pos:8080/providers/<provider-id>`. See [the provider integration guide](docs/ADDING_PROVIDER.md).

## Test controls

Payments succeed by default. Use a card number ending in `0000` to make a payment fail, or set the request header `X-Mock-Payment-Outcome: failure` / `success` for an explicit per-request result. `MOCK_PAYMENT_OUTCOME=failure` makes all unspecified payments fail.

For either hosted 3-D page, enter `123456` to authenticate successfully; any other code fails. This lets browser-based tests exercise both redirects and final authorization.

The full provider test-card catalog and the mock-only magic CVV error controls are in [TEST_CARDS.md](TEST_CARDS.md).

## PayTR Direct API

Point the PayTR form action to:

```text
POST http://mock-pos:8080/providers/paytr/odeme
```

The endpoint accepts the documented Direct API form payload, including `merchant_id`, `paytr_token`, `user_ip`, `merchant_oid`, `email`, `payment_amount`, `payment_type`, `installment_count`, `non_3d`, `user_address`, `user_phone`, and `user_basket`.

- Send `non_3d=1` for a non-3D payment. With `sync_mode=1`, the mock replies with PayTR-style JSON (`success` or `failed`). Without sync mode it redirects to `merchant_ok_url` or `merchant_fail_url`.
- Send `non_3d=0` for 3-D. The response is the mock 3-D page; submitting its code redirects to the supplied success or failure URL.
- Set `PAYTR_CALLBACK_URL` to forward a URL-encoded PayTR-style callback after completion. For example, in Compose use `http://my-app:3000/paytr/callback`. The mock sends `merchant_oid`, `status`, `total_amount`, `payment_amount`, `test_mode`, `payment_type`, `currency`, and `installment_count`; failed callbacks also include PayTR’s failure fields.
- To verify request tokens and produce callback hashes, configure both `PAYTR_MERCHANT_KEY` and `PAYTR_MERCHANT_SALT`. The token formula follows PayTR’s Direct API documentation. If they are omitted, tokens are accepted to keep test setup minimal.

## iyzico

Use a JSON request and an `Authorization` header beginning with `IYZWSv2 `, just as iyzico requires. The mock verifies the prefix and required payment fields but intentionally does not validate the cryptographic signature.

| Flow | Endpoint |
| --- | --- |
| Non-3D authorization | `POST /providers/iyzico/payment/auth` |
| Start 3-D | `POST /providers/iyzico/payment/3dsecure/initialize` |
| Finalize 3-D | `POST /providers/iyzico/payment/3dsecure/auth` or `POST /providers/iyzico/payment/v2/3dsecure/auth` |

The non-3D response contains the commonly consumed iyzico payment fields, including `status`, `paymentId`, `conversationId`, card details, and `itemTransactions`. A failure returns iyzico-style `errorCode: "10051"` and `NOT_SUFFICIENT_FUNDS`.

3-D initialization returns `paymentId` and base64 `threeDSHtmlContent`. Render that content in your test client, submit code `123456`, and the page redirects to `callbackUrl` with `paymentId`, `conversationData`, and `status`. Then call the auth endpoint with `paymentId` to get the final payment result.

## Lidio

Lidio API card payments are available at `http://mock-pos:8080/providers/lidio`. The mock supports Lidio’s API payment flow with a new card (`paymentInstrument: "NewCard"`) only:

| Flow | Endpoint |
| --- | --- |
| Non-3D process | `POST /providers/lidio/Payment/ProcessPayment` |
| Start 3-D process | `POST /providers/lidio/Payment/ProcessPayment` with `paymentType: "3D"` (or `is3DSecure: true`) |
| Finish 3-D process | `POST /providers/lidio/Payment/FinishPaymentProcess` |

Send `paymentInstrumentInfo.newCard.cardNumber`, plus optional `amount`, `currency`, `merchantPaymentId`, and `returnUrl`. A 3-D start returns `result: "RedirectRequired"`, `paymentId`, and `RedirectForm`; render that HTML, submit code `123456`, then call `FinishPaymentProcess` with `paymentId`. A card ending in `0000`, or mock CVV `051` / `084`, produces deterministic failures. The service aliases `/ProcessPayment` and `/FinishPaymentProcess` under the same provider base URL for clients that use the shorter documented method paths.

## Local verification

```sh
npm test
docker compose up --build
```

The test suite covers health, PayTR non-3D and 3-D flows, and iyzico non-3D plus initialize/auth 3-D flows.
