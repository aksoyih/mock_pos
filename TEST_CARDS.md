# Test cards and mock error triggers

This reference covers only the card-payment flows exposed by this project. The entries marked **official** are documented by the provider. The “magic CVV” values are **mock-pos conventions**: they are intentionally local-only controls that make otherwise hard-to-reproduce provider errors deterministic.

For all iyzico sandbox cards, use a future expiry and a correctly formatted CVV; iyzico documents that those values may be arbitrary. PayTR’s documented direct-API test cards use CVV `000` and expiry `12/30`.

## PayTR Direct API

| Purpose | Card number | Expiry | CVV | Result / callback `failed_reason_code` |
| --- | --- | --- | --- | --- |
| Official success (Visa) | `4355 0843 5508 4358` | `12/30` | `000` | `success` |
| Official success (Mastercard) | `5406 6754 0667 5403` | `12/30` | `000` | `success` |
| Official success (Troy) | `9792 0303 9444 0796` | `12/30` | `000` | `success` |
| Official non-3D failure switch | Any | Any | Any | Send `non3d_test_failed=1`; `failed_reason_code=0` |
| Mock: insufficient funds / decline | Any | Any | `900` | `0` |
| Mock: authentication not performed | Any | Any | `901` | `1` |
| Mock: authentication failed | Any | Any | `902` | `2` |
| Mock: security check declined | Any | Any | `903` | `3` |
| Mock: abandoned / expired session | Any | Any | `906` | `6` |
| Mock: installment unavailable | Any | Any | `908` | `8` |
| Mock: merchant not authorized for card | Any | Any | `909` | `9` |
| Mock: 3-D required | Any | Any | `910` | `10` |
| Mock: fraud/security alert | Any | Any | `911` | `11` |
| Mock: technical integration error | Any | Any | `999` | `99` |

For PayTR 3-D, the hosted mock screen additionally accepts verification code `123456` for success; any other code generates callback error `2`.

## iyzico sandbox cards

| Purpose / error group | Official test card | Mock response `errorCode` |
| --- | --- | --- |
| Success, Mastercard credit | `5526080000000006` | `success` |
| Success, Visa credit | `4603450000000000` | `success` |
| Success, Troy credit | `9792030000000000` | `success` |
| Insufficient funds | `4111111111111129` | `10051` / `NOT_SUFFICIENT_FUNDS` |
| Do not honour | `4129111111111111` | `10005` / `DO_NOT_HONOUR` |
| Invalid transaction | `4128111111111112` | `10012` / `INVALID_TRANSACTION` |
| Lost card | `4127111111111113` | `10043` / `LOST_CARD` |
| Stolen card | `4126111111111114` | `10043` / `STOLEN_CARD` |
| Expired card | `4125111111111115` | `10054` / `EXPIRED_CARD` |
| Invalid CVC2 | `4124111111111116` | `10084` / `INVALID_CVC2` |
| Cardholder not permitted | `4123111111111117` | `10057` / `NOT_PERMITTED_TO_CARDHOLDER` |
| Terminal not permitted | `4122111111111118` | `10058` / `NOT_PERMITTED_TO_TERMINAL` |
| Fraud suspected | `4121111111111119` | `10034` / `FRAUD_SUSPECT` |
| Pick up card | `4120111111111110` | `10041` / `PICKUP_CARD` |
| General error | `4130111111111118` | `10202` / `UNKNOWN` |
| 3-D succeeds with `mdStatus=0` | `4131111111111117` | `success`, `mdStatus: 0` |
| 3-D succeeds with `mdStatus=4` | `4141111111111115` | `success`, `mdStatus: 4` |
| 3-D initialization fails | `4151111111111112` | `10202` / `INIT_3DS` |
| Success but refund/cancel/post-auth unavailable | `5406670000000009` | `success` (those APIs are out of scope) |

## iyzico mock-only magic CVVs

Use one of these values with any otherwise successful card to force a predictable response locally. An official iyzico error-card number takes precedence over a magic CVV.

| CVV | `errorCode` | `errorGroup` |
| --- | --- | --- |
| `005` | `10005` | `DO_NOT_HONOUR` |
| `051` | `10051` | `NOT_SUFFICIENT_FUNDS` |
| `054` | `10054` | `EXPIRED_CARD` |
| `084` | `10084` | `INVALID_CVC2` |
| `034` | `10034` | `FRAUD_SUSPECT` |
| `220` | `10220` | `DECLINED` |

Sources: [PayTR test cards](https://dev.paytr.com/en/direkt-api/test-kart-bilgileri), [PayTR payment error codes](https://dev.paytr.com/en/hata-kodlari), [iyzico test cards](https://docs.iyzico.com/en/add-ons/test-cards), and [iyzico error codes](https://docs.iyzico.com/en/add-ons/error-codes).
