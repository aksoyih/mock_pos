import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const payments = new Map();
let sequence = 10000000;

function now() { return Date.now(); }
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function text(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
async function form(req) { return Object.fromEntries(new URLSearchParams(await body(req))); }
async function payload(req) {
  const raw = await body(req);
  try { return JSON.parse(raw); } catch { return null; }
}
function outcome(req, card = '') {
  const requested = req.headers['x-mock-payment-outcome'];
  if (requested === 'failure' || requested === 'fail') return 'failure';
  if (requested === 'success') return 'success';
  if (process.env.MOCK_PAYMENT_OUTCOME === 'failure') return 'failure';
  return String(card).replace(/\s/g, '').endsWith('0000') ? 'failure' : 'success';
}
function required(object, fields) { return fields.filter((field) => !object[field] && object[field] !== 0); }
function paytrHash(data) {
  return createHmac('sha256', process.env.PAYTR_MERCHANT_KEY).update(data).digest('base64');
}
function paytrTokenValid(p) {
  if (!process.env.PAYTR_MERCHANT_KEY || !process.env.PAYTR_MERCHANT_SALT) return true;
  const source = `${p.merchant_id}${p.user_ip}${p.merchant_oid}${p.email}${p.payment_amount}${p.payment_type}${p.installment_count}${p.currency || 'TL'}${p.test_mode || '0'}${p.non_3d}`;
  return p.paytr_token === paytrHash(source + process.env.PAYTR_MERCHANT_SALT);
}
function iyziBase(input) {
  const card = input.paymentCard || {};
  return {
    status: 'success', locale: input.locale || 'tr', systemTime: now(),
    conversationId: input.conversationId, price: String(input.price), paidPrice: String(input.paidPrice),
    installment: input.installment || 1, paymentId: String(sequence++), fraudStatus: 1,
    merchantCommissionRate: 0, merchantCommissionRateAmount: 0, iyziCommissionRateAmount: 0,
    iyziCommissionFee: 0.25, cardType: 'CREDIT_CARD', cardAssociation: card.cardNumber?.startsWith('4') ? 'VISA' : 'MASTER_CARD',
    cardFamily: 'Mock Card', binNumber: String(card.cardNumber || '').slice(0, 6), lastFourDigits: String(card.cardNumber || '').slice(-4),
    basketId: input.basketId, currency: input.currency || 'TRY', itemTransactions: (input.basketItems || []).map((item, index) => ({
      itemId: item.id, paymentTransactionId: `mock-tx-${index + 1}`, transactionStatus: 2, price: String(item.price), paidPrice: String(item.price),
      commission: 0, iyziCommissionFee: 0.25, iyziCommissionRateAmount: 0, merchantCommissionRate: 0, merchantCommissionRateAmount: 0
    }))
  };
}
function iyziFailure(input) {
  return { status: 'failure', locale: input.locale || 'tr', systemTime: now(), conversationId: input.conversationId, errorCode: '10051', errorMessage: 'Insufficient funds', errorGroup: 'NOT_SUFFICIENT_FUNDS' };
}
function callbackPaytr(p, status) {
  const target = process.env.PAYTR_CALLBACK_URL;
  if (!target) return;
  const total = status === 'success' ? String(Math.round(Number(p.payment_amount) * 100)) : '0';
  const notification = { merchant_oid: p.merchant_oid, status, total_amount: total, payment_amount: String(Math.round(Number(p.payment_amount) * 100)), test_mode: p.test_mode || '1', payment_type: 'card', currency: p.currency || 'TL', installment_count: p.installment_count || '0' };
  if (status === 'failed') Object.assign(notification, { failed_reason_code: '0', failed_reason_msg: 'Mock card declined' });
  if (process.env.PAYTR_MERCHANT_KEY && process.env.PAYTR_MERCHANT_SALT) notification.hash = paytrHash(`${p.merchant_oid}${process.env.PAYTR_MERCHANT_SALT}${status}${total}`);
  fetch(target, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(notification) }).catch(() => {});
}
function paytrComplete(res, p, status) {
  callbackPaytr(p, status);
  if (p.sync_mode === '1') return json(res, 200, status === 'success' ? { status: 'success', msg: 'Successful Payment.', utoken: 'mock-utoken', ctoken: 'mock-ctoken' } : { status: 'failed', msg: 'Mock card declined' });
  const destination = status === 'success' ? p.merchant_ok_url : p.merchant_fail_url;
  if (!destination) return text(res, 200, status === 'success' ? 'Payment successful' : 'Payment failed');
  const url = new URL(destination);
  if (status === 'failed') url.searchParams.set('fail_message', 'Mock card declined');
  res.writeHead(302, { location: url.toString() }); res.end();
}
function threeDsPage(id) {
  return `<!doctype html><html><body><h1>Mock PayTR 3D Secure</h1><p>Enter <b>123456</b> to approve. Any other value declines.</p><form method="post" action="/paytr/3ds/${id}"><label>Verification code <input name="code" autofocus></label><button>Complete payment</button></form></body></html>`;
}
async function handlePaytr(req, res) {
  if (req.method !== 'POST' || req.url !== '/odeme') return false;
  const p = await form(req);
  const missing = required(p, ['merchant_id', 'paytr_token', 'user_ip', 'merchant_oid', 'email', 'payment_amount', 'payment_type', 'installment_count', 'non_3d', 'user_address', 'user_phone', 'user_basket']);
  if (missing.length) return text(res, 400, `Missing required fields: ${missing.join(', ')}`);
  if (!paytrTokenValid(p)) return text(res, 400, 'Invalid paytr_token');
  const result = outcome(req, p.card_number);
  if (p.non_3d === '1') return paytrComplete(res, p, result === 'success' ? 'success' : 'failed');
  const id = randomUUID(); payments.set(id, { provider: 'paytr', request: p, result });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(threeDsPage(id)); return true;
}
async function handlePaytr3ds(req, res, pathname) {
  const match = pathname.match(/^\/paytr\/3ds\/([^/]+)$/);
  if (!match || req.method !== 'POST') return false;
  const payment = payments.get(match[1]);
  if (!payment || payment.provider !== 'paytr') return text(res, 404, 'Unknown payment');
  const values = await form(req);
  const status = payment.result === 'success' && values.code === '123456' ? 'success' : 'failed';
  return paytrComplete(res, payment.request, status);
}
function validIyziRequest(req, input, res) {
  if (!String(req.headers.authorization || '').startsWith('IYZWSv2 ')) { json(res, 401, { status: 'failure', errorCode: '401', errorMessage: 'Authorization header must start with IYZWSv2' }); return false; }
  const missing = required(input || {}, ['price', 'paidPrice', 'paymentCard', 'buyer', 'billingAddress', 'basketItems']);
  if (missing.length) { json(res, 400, { status: 'failure', errorCode: '10001', errorMessage: `Missing required fields: ${missing.join(', ')}` }); return false; }
  return true;
}
function iyziHtml(id) {
  return `<!doctype html><html><body><h1>Mock iyzico 3D Secure</h1><form method="post" action="/iyzico/3ds/${id}"><label>Verification code <input name="code" autofocus></label><button>Complete payment</button></form><p>Use <b>123456</b> to approve.</p></body></html>`;
}
async function handleIyzi(req, res, pathname) {
  if (!['/payment/auth', '/payment/3dsecure/initialize', '/payment/3dsecure/auth', '/payment/v2/3dsecure/auth'].includes(pathname)) return false;
  if (req.method !== 'POST') return json(res, 405, { status: 'failure', errorMessage: 'Method not allowed' });
  const input = await payload(req);
  if (pathname.endsWith('/auth') && pathname !== '/payment/auth') {
    if (!String(req.headers.authorization || '').startsWith('IYZWSv2 ')) return json(res, 401, { status: 'failure', errorCode: '401', errorMessage: 'Authorization header must start with IYZWSv2' });
    if (!input?.paymentId) return json(res, 400, { status: 'failure', errorCode: '10001', errorMessage: 'Missing required fields: paymentId' });
  } else if (!validIyziRequest(req, input, res)) return true;
  if (pathname === '/payment/auth') {
    const response = outcome(req, input.paymentCard?.cardNumber) === 'success' ? iyziBase(input) : iyziFailure(input);
    if (response.status === 'success') payments.set(response.paymentId, { provider: 'iyzico', input, response });
    return json(res, 200, response);
  }
  if (pathname.includes('initialize')) {
    if (!input.callbackUrl) return json(res, 400, { status: 'failure', errorCode: '10001', errorMessage: 'Missing required fields: callbackUrl' });
    const id = String(sequence++); const result = outcome(req, input.paymentCard?.cardNumber);
    payments.set(id, { provider: 'iyzico', input, result });
    return json(res, 200, { status: 'success', locale: input.locale || 'tr', systemTime: now(), conversationId: input.conversationId, paymentId: id, threeDSHtmlContent: Buffer.from(iyziHtml(id)).toString('base64') });
  }
  const payment = payments.get(String(input.paymentId));
  if (!payment || payment.provider !== 'iyzico') return json(res, 404, { status: 'failure', errorCode: '10004', errorMessage: 'Payment not found' });
  const response = payment.result === 'success' ? { ...iyziBase(payment.input), paymentId: String(input.paymentId), authCode: '123456', phase: 'AUTH', mdStatus: 1, hostReference: `mock${input.paymentId}iyzihostrfn` } : { ...iyziFailure(payment.input), mdStatus: 0 };
  return json(res, 200, response);
}
async function handleIyzi3ds(req, res, pathname) {
  const match = pathname.match(/^\/iyzico\/3ds\/(.+)$/);
  if (!match || req.method !== 'POST') return false;
  const payment = payments.get(match[1]); if (!payment) return text(res, 404, 'Unknown payment');
  const values = await form(req); const url = new URL(payment.input.callbackUrl);
  url.searchParams.set('paymentId', match[1]); url.searchParams.set('conversationData', 'mock-conversation-data');
  url.searchParams.set('status', payment.result === 'success' && values.code === '123456' ? 'success' : 'failure');
  res.writeHead(302, { location: url.toString() }); res.end(); return true;
}
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && pathname === '/health') return json(res, 200, { status: 'ok' });
  if (req.method === 'POST' && pathname === '/odeme') { await handlePaytr(req, res); return; }
  if (req.method === 'POST' && /^\/paytr\/3ds\/[^/]+$/.test(pathname)) { await handlePaytr3ds(req, res, pathname); return; }
  if (['/payment/auth', '/payment/3dsecure/initialize', '/payment/3dsecure/auth', '/payment/v2/3dsecure/auth'].includes(pathname)) { await handleIyzi(req, res, pathname); return; }
  if (req.method === 'POST' && /^\/iyzico\/3ds\/.+$/.test(pathname)) { await handleIyzi3ds(req, res, pathname); return; }
  json(res, 404, { error: 'Not found' });
});
if (process.env.NODE_ENV !== 'test') server.listen(PORT, () => console.log(`mock-pos listening on ${PORT}`));
export { server };
