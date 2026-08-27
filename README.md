# mock-pos Laravel package

`haluk/mock-pos` is a local payment-gateway mock for Laravel 10–13 integration and feature tests. It implements card-payment endpoints for PayTR, iyzico, Lidio, and Garanti BBVA. It is test infrastructure only; do not enable it in production or expose it to the internet.

> **Unofficial integration mock.** This project is not affiliated with, endorsed by, or supported by PayTR, iyzico, Lidio, or Garanti BBVA. Provider names are used only to identify the APIs whose request and response contracts are simulated. This repository contains no provider logos, SDK source, checkout assets, live credentials, or real customer/payment data.

## Install

Add the package from its VCS repository while it is unpublished, then require it as a development dependency:

```sh
composer require --dev haluk/mock-pos
```

Keep it in `require-dev` for a normal test suite or ephemeral test environment. Install it as a regular dependency only when the deployed test environment must serve these mock HTTP routes at runtime and its deployment uses `composer install --no-dev`; never install it in a production application.

Laravel discovers the service provider automatically. To change route mounting or configure PayTR callbacks, publish the config:

```sh
php artisan vendor:publish --tag=mock-pos-config
```

By default routes retain the original API paths:

| Provider | Base path |
| --- | --- |
| PayTR | `/providers/paytr` |
| iyzico | `/providers/iyzico` |
| Lidio | `/providers/lidio` |
| Garanti BBVA | `/providers/garanti` |

Set `MOCK_POS_ROUTE_PREFIX=mock-pos` to mount all package endpoints beneath `/mock-pos` instead. The health check is available at `/health` (or `/mock-pos/health` with a prefix).

## Test controls

Payments succeed by default. A card number ending in `0000`, `X-Mock-Payment-Outcome: failure`, or `MOCK_PAYMENT_OUTCOME=failure` produces a decline. Use the `success` header to override the configured default for one request.

Hosted 3-D pages accept `123456`; Garanti accepts `147852`.

## Provider flows

The package maintains the Node mock's provider routes and response shapes:

- PayTR: `POST /providers/paytr/odeme`, refunds at `/odeme/iade`, mock cancellation at `/odeme/iptal`.
- iyzico: `POST /payment/auth`, `/payment/3dsecure/initialize`, `/payment/3dsecure/auth`, cancel and refund routes.
- Lidio: `POST /Payment/ProcessPayment`, `/Payment/FinishPaymentProcess`, mock cancel/refund routes.
- Garanti: XML `POST /VPServlet` and form `POST /servlet/gt3dengine`.

See [TEST_CARDS.md](TEST_CARDS.md) for deterministic provider card and CVV errors. See [docs/ADDING_PROVIDER.md](docs/ADDING_PROVIDER.md) for the provider-mounting convention.

## Development

```sh
composer install
composer test
```

The package uses an in-memory payment store, so state is intentionally reset between PHP processes. For parallel tests, isolate callers per application instance.
