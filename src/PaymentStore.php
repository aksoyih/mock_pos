<?php

namespace Haluk\MockPos;

class PaymentStore
{
    /** @var array<string, array<string, mixed>> */
    private array $payments = [];
    private int $sequence = 10000000;

    public function put(string $key, array $payment): void { $this->payments[$key] = $payment; }
    public function get(string $key): ?array { return $this->payments[$key] ?? null; }
    public function update(string $key, array $payment): void { $this->payments[$key] = $payment; }
    public function nextId(): string { return (string) $this->sequence++; }
}
