<?php

return [
    /* Set this to e.g. 'mock-pos' to avoid sharing the application's root paths. */
    'route_prefix' => env('MOCK_POS_ROUTE_PREFIX', ''),
    'middleware' => [],
    'payment_outcome' => env('MOCK_PAYMENT_OUTCOME'),
    'paytr' => [
        'merchant_key' => env('PAYTR_MERCHANT_KEY'),
        'merchant_salt' => env('PAYTR_MERCHANT_SALT'),
        'callback_url' => env('PAYTR_CALLBACK_URL'),
    ],
];
