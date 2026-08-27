import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { scopedProvider } from './providers.js';

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
const PAYTR_CVV_ERRORS = {
  '900': ['0', 'Mock card declined'], '901': ['1', 'Authentication not performed'], '902': ['2', 'Authentication failed'],
  '903': ['3', 'Security check declined'], '906': ['6', 'Customer abandoned payment'], '908': ['8', 'Installment not permitted'],
  '909': ['9', 'Card not authorized'], '910': ['10', '3D Secure is required'], '911': ['11', 'Security alert'], '999': ['99', 'Technical integration error']
};
const IYZI_CARD_ERRORS = {
  '4111111111111129': ['10051', 'NOT_SUFFICIENT_FUNDS', 'Insufficient card limit, insufficient balance'],
  '4129111111111111': ['10005', 'DO_NOT_HONOUR', 'Transaction not approved'],
  '4128111111111112': ['10012', 'INVALID_TRANSACTION', 'Invalid transaction'],
  '4127111111111113': ['10043', 'LOST_CARD', 'Lost card'], '4126111111111114': ['10043', 'STOLEN_CARD', 'Stolen card'],
  '4125111111111115': ['10054', 'EXPIRED_CARD', 'Expiry date incorrect'], '4124111111111116': ['10084', 'INVALID_CVC2', 'Incorrect CVC2 information'],
  '4123111111111117': ['10057', 'NOT_PERMITTED_TO_CARDHOLDER', 'Cardholder cannot perform this transaction'],
  '4122111111111118': ['10058', 'NOT_PERMITTED_TO_TERMINAL', 'Terminal not authorized for this transaction'],
  '4121111111111119': ['10034', 'FRAUD_SUSPECT', 'Payment failed to pass security check'], '4120111111111110': ['10041', 'PICKUP_CARD', 'Pickup card'],
  '4130111111111118': ['10202', 'UNKNOWN', 'A general error occurred during the payment process']
};
const IYZI_CVV_ERRORS = {
  '005': ['10005', 'DO_NOT_HONOUR', 'Transaction not approved'], '051': ['10051', 'NOT_SUFFICIENT_FUNDS', 'Insufficient card limit, insufficient balance'],
  '054': ['10054', 'EXPIRED_CARD', 'Expiry date incorrect'], '084': ['10084', 'INVALID_CVC2', 'Incorrect CVC2 information'],
  '034': ['10034', 'FRAUD_SUSPECT', 'Payment failed to pass security check'], '220': ['10220', 'DECLINED', 'Payment not accepted']
};
function outcome(req, card = '') {
  const requested = req.headers['x-mock-payment-outcome'];
  if (requested === 'failure' || requested === 'fail') return 'failure';
  if (requested === 'success') return 'success';
  if (process.env.MOCK_PAYMENT_OUTCOME === 'failure') return 'failure';
  return String(card).replace(/\s/g, '').endsWith('0000') ? 'failure' : 'success';
}
function paytrResult(req, p) {
  const magic = PAYTR_CVV_ERRORS[p.cvv];
  if (magic) return { status: 'failed', code: magic[0], message: magic[1] };
  if (p.non3d_test_failed === '1') return { status: 'failed', code: '0', message: 'Mock card declined' };
  return outcome(req, p.card_number) === 'success' ? { status: 'success' } : { status: 'failed', code: '0', message: 'Mock card declined' };
}
function iyziResult(req, input) {
  const card = String(input.paymentCard?.cardNumber || '').replace(/\s/g, '');
  if (card === '4131111111111117') return { status: 'success', mdStatus: 0 };
  if (card === '4141111111111115') return { status: 'success', mdStatus: 4 };
  if (card === '4151111111111112') return { status: 'failure', code: '10202', group: 'INIT_3DS', message: '3D Secure initialization failed', initFail: true };
  const magic = IYZI_CARD_ERRORS[card] || IYZI_CVV_ERRORS[input.paymentCard?.cvc];
  if (magic) return { status: 'failure', code: magic[0], group: magic[1], message: magic[2] };
  return outcome(req, card) === 'success' ? { status: 'success' } : { status: 'failure', code: '10051', group: 'NOT_SUFFICIENT_FUNDS', message: 'Insufficient funds' };
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
function iyziFailure(input, result = {}) {
  return { status: 'failure', locale: input.locale || 'tr', systemTime: now(), conversationId: input.conversationId, errorCode: result.code || '10051', errorMessage: result.message || 'Insufficient funds', errorGroup: result.group || 'NOT_SUFFICIENT_FUNDS' };
}
function callbackPaytr(p, result) {
  const target = process.env.PAYTR_CALLBACK_URL;
  if (!target) return;
  const status = result.status;
  const total = status === 'success' ? String(Math.round(Number(p.payment_amount) * 100)) : '0';
  const notification = { merchant_oid: p.merchant_oid, status, total_amount: total, payment_amount: String(Math.round(Number(p.payment_amount) * 100)), test_mode: p.test_mode || '1', payment_type: 'card', currency: p.currency || 'TL', installment_count: p.installment_count || '0' };
  if (status === 'failed') Object.assign(notification, { failed_reason_code: result.code || '0', failed_reason_msg: result.message || 'Mock card declined' });
  if (process.env.PAYTR_MERCHANT_KEY && process.env.PAYTR_MERCHANT_SALT) notification.hash = paytrHash(`${p.merchant_oid}${process.env.PAYTR_MERCHANT_SALT}${status}${total}`);
  fetch(target, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(notification) }).catch(() => {});
}
function paytrComplete(res, p, result) {
  callbackPaytr(p, result);
  if (p.sync_mode === '1') return json(res, 200, result.status === 'success' ? { status: 'success', msg: 'Successful Payment.', utoken: 'mock-utoken', ctoken: 'mock-ctoken' } : { status: 'failed', msg: result.message || 'Mock card declined' });
  const destination = result.status === 'success' ? p.merchant_ok_url : p.merchant_fail_url;
  if (!destination) return text(res, 200, result.status === 'success' ? 'Payment successful' : 'Payment failed');
  const url = new URL(destination);
  if (result.status === 'failed') url.searchParams.set('fail_message', result.message || 'Mock card declined');
  res.writeHead(302, { location: url.toString() }); res.end();
}
function threeDsPage(id, mountPath = '') {
  return `<!doctype html><html><body><h1>Mock PayTR 3D Secure</h1><p>Enter <b>123456</b> to approve. Any other value declines.</p><form method="post" action="${mountPath}/paytr/3ds/${id}"><label>Verification code <input name="code" autofocus></label><button>Complete payment</button></form></body></html>`;
}
async function handlePaytr(req, res, mountPath = '') {
  const p = await form(req);
  const missing = required(p, ['merchant_id', 'paytr_token', 'user_ip', 'merchant_oid', 'email', 'payment_amount', 'payment_type', 'installment_count', 'non_3d', 'user_address', 'user_phone', 'user_basket']);
  if (missing.length) return text(res, 400, `Missing required fields: ${missing.join(', ')}`);
  if (!paytrTokenValid(p)) return text(res, 400, 'Invalid paytr_token');
  const result = paytrResult(req, p);
  if (p.non_3d === '1') return paytrComplete(res, p, result);
  const id = randomUUID(); payments.set(id, { provider: 'paytr', request: p, result });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(threeDsPage(id, mountPath)); return true;
}
async function handlePaytr3ds(req, res, pathname) {
  const match = pathname.match(/^\/paytr\/3ds\/([^/]+)$/);
  if (!match || req.method !== 'POST') return false;
  const payment = payments.get(match[1]);
  if (!payment || payment.provider !== 'paytr') return text(res, 404, 'Unknown payment');
  const values = await form(req);
  const result = payment.result.status === 'success' && values.code === '123456' ? payment.result : { status: 'failed', code: '2', message: 'Authentication failed' };
  return paytrComplete(res, payment.request, result);
}
function validIyziRequest(req, input, res) {
  if (!String(req.headers.authorization || '').startsWith('IYZWSv2 ')) { json(res, 401, { status: 'failure', errorCode: '401', errorMessage: 'Authorization header must start with IYZWSv2' }); return false; }
  const missing = required(input || {}, ['price', 'paidPrice', 'paymentCard', 'buyer', 'billingAddress', 'basketItems']);
  if (missing.length) { json(res, 400, { status: 'failure', errorCode: '10001', errorMessage: `Missing required fields: ${missing.join(', ')}` }); return false; }
  return true;
}
function iyziHtml(id, mountPath = '') {
  return `<!doctype html><html><body><h1>Mock iyzico 3D Secure</h1><form method="post" action="${mountPath}/iyzico/3ds/${id}"><label>Verification code <input name="code" autofocus></label><button>Complete payment</button></form><p>Use <b>123456</b> to approve.</p></body></html>`;
}
async function handleIyzi(req, res, pathname, mountPath = '') {
  if (!['/payment/auth', '/payment/3dsecure/initialize', '/payment/3dsecure/auth', '/payment/v2/3dsecure/auth'].includes(pathname)) return false;
  if (req.method !== 'POST') return json(res, 405, { status: 'failure', errorMessage: 'Method not allowed' });
  const input = await payload(req);
  if (pathname.endsWith('/auth') && pathname !== '/payment/auth') {
    if (!String(req.headers.authorization || '').startsWith('IYZWSv2 ')) return json(res, 401, { status: 'failure', errorCode: '401', errorMessage: 'Authorization header must start with IYZWSv2' });
    if (!input?.paymentId) return json(res, 400, { status: 'failure', errorCode: '10001', errorMessage: 'Missing required fields: paymentId' });
  } else if (!validIyziRequest(req, input, res)) return true;
  if (pathname === '/payment/auth') {
    const result = iyziResult(req, input);
    const response = result.status === 'success' ? iyziBase(input) : iyziFailure(input, result);
    if (response.status === 'success') payments.set(response.paymentId, { provider: 'iyzico', input, response });
    return json(res, 200, response);
  }
  if (pathname.includes('initialize')) {
    if (!input.callbackUrl) return json(res, 400, { status: 'failure', errorCode: '10001', errorMessage: 'Missing required fields: callbackUrl' });
    const id = String(sequence++); const result = iyziResult(req, input);
    if (result.initFail) return json(res, 200, iyziFailure(input, result));
    payments.set(id, { provider: 'iyzico', input, result });
    return json(res, 200, { status: 'success', locale: input.locale || 'tr', systemTime: now(), conversationId: input.conversationId, paymentId: id, threeDSHtmlContent: Buffer.from(iyziHtml(id, mountPath)).toString('base64') });
  }
  const payment = payments.get(String(input.paymentId));
  if (!payment || payment.provider !== 'iyzico') return json(res, 404, { status: 'failure', errorCode: '10004', errorMessage: 'Payment not found' });
  const response = payment.result.status === 'success' ? { ...iyziBase(payment.input), paymentId: String(input.paymentId), authCode: '123456', phase: 'AUTH', mdStatus: payment.result.mdStatus ?? 1, hostReference: `mock${input.paymentId}iyzihostrfn` } : { ...iyziFailure(payment.input, payment.result), mdStatus: 0 };
  return json(res, 200, response);
}
async function handleIyzi3ds(req, res, pathname) {
  const match = pathname.match(/^\/iyzico\/3ds\/(.+)$/);
  if (!match || req.method !== 'POST') return false;
  const payment = payments.get(match[1]); if (!payment) return text(res, 404, 'Unknown payment');
  const values = await form(req); const url = new URL(payment.input.callbackUrl);
  url.searchParams.set('paymentId', match[1]); url.searchParams.set('conversationData', 'mock-conversation-data');
  url.searchParams.set('status', payment.result.status === 'success' && values.code === '123456' ? 'success' : 'failure');
  res.writeHead(302, { location: url.toString() }); res.end(); return true;
}
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && pathname === '/health') return json(res, 200, { status: 'ok' });
  const scoped = scopedProvider(pathname);
  if (scoped?.id === 'paytr') {
    if (req.method === 'POST' && scoped.pathname === '/odeme') { await handlePaytr(req, res, scoped.mountPath); return; }
    if (req.method === 'POST' && /^\/paytr\/3ds\/[^/]+$/.test(scoped.pathname)) { await handlePaytr3ds(req, res, scoped.pathname); return; }
  }
  if (scoped?.id === 'iyzico') {
    if (['/payment/auth', '/payment/3dsecure/initialize', '/payment/3dsecure/auth', '/payment/v2/3dsecure/auth'].includes(scoped.pathname)) { await handleIyzi(req, res, scoped.pathname, scoped.mountPath); return; }
    if (req.method === 'POST' && /^\/iyzico\/3ds\/.+$/.test(scoped.pathname)) { await handleIyzi3ds(req, res, scoped.pathname); return; }
  }
  if (scoped) return json(res, 404, { error: `Unknown provider or endpoint: ${scoped.id}` });
  json(res, 404, { error: 'Not found' });
});
if (process.env.NODE_ENV !== 'test') server.listen(PORT, () => console.log(`mock-pos listening on ${PORT}`));
export { server };
