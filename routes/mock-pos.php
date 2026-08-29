<?php

use Aksoyih\MockPos\Http\Controllers\MockPosController;
use Illuminate\Support\Facades\Route;

Route::get('/health', [MockPosController::class, 'health'])->name('mock-pos.health');
Route::any('/providers/{provider}/{path?}', [MockPosController::class, 'handle'])
    ->where('path', '.*')
    ->name('mock-pos.provider');
