<?php

namespace Aksoyih\MockPos;

use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

class MockPosServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/mock-pos.php', 'mock-pos');
        $this->app->singleton(PaymentStore::class);
    }

    public function boot(): void
    {
        $this->publishes([__DIR__.'/../config/mock-pos.php' => config_path('mock-pos.php')], 'mock-pos-config');

        Route::middleware(config('mock-pos.middleware', []))
            ->prefix(trim((string) config('mock-pos.route_prefix', ''), '/'))
            ->group(__DIR__.'/../routes/mock-pos.php');
    }
}
