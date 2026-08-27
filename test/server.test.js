import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { server } from '../src/server.js';

server.listen(0); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const iyziHeaders = { authorization: 'IYZWSv2 mock-signature', 'content-type': 'application/json' };

function paytrRequest(overrides = {}) {
  return new URLSearchParams({
    merchant_id: '1', paytr_token: 'mock', user_ip: '127.0.0.1', merchant_oid: `order-${Math.random()}`,
    email: 'buyer@example.com', payment_amount: '10.50', payment_type: 'card', installment_count: '0', non_3d: '1',
    user_address: 'Istanbul', user_phone: '5555555555', user_basket: '[]', merchant_ok_url: 'https://merchant.test/ok', merchant_fail_url: 'https://merchant.test/fail', ...overrides
  });
}
function iyziRequest(overrides = {}) {
  return { locale: 'en', conversationId: 'conv-1', price: 10, paidPrice: 10, currency: 'TRY', basketId: 'basket-1',
    paymentCard: { cardHolderName: 'Mock User', cardNumber: '5528790000000008', expireMonth: '12', expireYear: '30', cvc: '123' },
    buyer: { id: 'buyer-1', name: 'Mock', surname: 'User', identityNumber: '11111111111', email: 'buyer@example.com', gsmNumber: '+905555555555' },
    billingAddress: { contactName: 'Mock User', city: 'Istanbul', country: 'Turkey', address: 'Mock address', zipCode: '34000' },
    basketItems: [{ id: 'item-1', name: 'Mock item', category1: 'Mock', itemType: 'VIRTUAL', price: 10 }], ...overrides };
}

test('health check is available', async () => {
  const response = await fetch(`${base}/health`);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('PayTR non-3D success uses its sync response', async () => {
  const response = await fetch(`${base}/odeme`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: paytrRequest({ sync_mode: '1' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'success');
});

test('PayTR 3-D page completes after its verification code', async () => {
  const initialized = await fetch(`${base}/odeme`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: paytrRequest({ non_3d: '0' }) });
  const html = await initialized.text(); assert.match(html, /Mock PayTR 3D Secure/);
  const action = html.match(/action="([^"]+)"/)[1];
  const finished = await fetch(`${base}${action}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=123456', redirect: 'manual' });
  assert.equal(finished.status, 302);
  assert.match(finished.headers.get('location'), /merchant\.test\/ok/);
});

test('iyzico non-3D payment returns a provider-shaped success response', async () => {
  const response = await fetch(`${base}/payment/auth`, { method: 'POST', headers: iyziHeaders, body: JSON.stringify(iyziRequest()) });
  const result = await response.json();
  assert.equal(result.status, 'success'); assert.equal(result.conversationId, 'conv-1'); assert.ok(result.paymentId);
});

test('iyzico 3-D initialize then auth completes a payment', async () => {
  const initialized = await fetch(`${base}/payment/3dsecure/initialize`, { method: 'POST', headers: iyziHeaders, body: JSON.stringify(iyziRequest({ callbackUrl: 'https://merchant.test/callback' })) });
  const init = await initialized.json(); assert.equal(init.status, 'success'); assert.ok(init.threeDSHtmlContent);
  const completed = await fetch(`${base}/payment/3dsecure/auth`, { method: 'POST', headers: iyziHeaders, body: JSON.stringify({ paymentId: init.paymentId, conversationId: 'conv-1', conversationData: 'mock-conversation-data' }) });
  const result = await completed.json(); assert.equal(result.status, 'success'); assert.equal(result.mdStatus, 1);
});

test.after(() => server.close());
