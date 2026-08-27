import { randomUUID } from 'node:crypto';

const PROCESS_PATHS = new Set(['/ProcessPayment', '/Payment/ProcessPayment', '/api/Payment/ProcessPayment']);
const FINISH_PATHS = new Set(['/FinishPaymentProcess', '/Payment/FinishPaymentProcess', '/api/Payment/FinishPaymentProcess']);

function cardFrom(input) {
  return input.paymentInstrumentInfo?.newCard || input.paymentInstrumentInfo?.card || {};
}
function isThreeD(input) {
  return ['3D', '3DS', 'THREEDS'].includes(String(input.paymentType || input.paymentSecurity || input.paymentModel || '').toUpperCase())
    || input.is3DSecure === true || input.threeDSecure === true;
}
function paymentResult(req, card) {
  const forced = req.headers['x-mock-payment-outcome'];
  if (forced === 'failure' || forced === 'fail' || String(card.cardNumber || '').replace(/\s/g, '').endsWith('0000')) {
    return { result: 'Failed', errorCode: 'InsufficientFunds', errorMessage: 'Insufficient funds' };
  }
  if (card.cvv === '051') return { result: 'Failed', errorCode: 'InsufficientFunds', errorMessage: 'Insufficient funds' };
  if (card.cvv === '084') return { result: 'Failed', errorCode: 'InvalidCvv', errorMessage: 'Invalid CVV' };
  return { result: 'Success' };
}
function threeDsHtml(paymentId, mountPath) {
  return `<!doctype html><html><body><h1>Mock Lidio 3D Secure</h1><p>Enter <b>123456</b> to approve.</p><form method="post" action="${mountPath}/lidio/3ds/${paymentId}"><label>Verification code <input name="code" autofocus></label><button>Complete payment</button></form></body></html>`;
}

export function createLidioHandler({ payments, nextPaymentId, json, text, payload, form }) {
  async function handle(req, res, pathname, mountPath) {
    if (req.method !== 'POST') return json(res, 405, { result: 'Failed', errorCode: 'MethodNotAllowed', errorMessage: 'Method not allowed' });
    if (PROCESS_PATHS.has(pathname)) {
      const input = await payload(req);
      if (!input?.paymentInstrument || !input?.paymentInstrumentInfo) {
        return json(res, 400, { result: 'Failed', errorCode: 'ValidationError', errorMessage: 'paymentInstrument and paymentInstrumentInfo are required' });
      }
      if (String(input.paymentInstrument).toLowerCase() !== 'newcard') {
        return json(res, 400, { result: 'Failed', errorCode: 'UnsupportedInstrument', errorMessage: 'Only NewCard payments are mocked' });
      }
      const card = cardFrom(input);
      if (!card.cardNumber) return json(res, 400, { result: 'Failed', errorCode: 'ValidationError', errorMessage: 'paymentInstrumentInfo.newCard.cardNumber is required' });
      const result = paymentResult(req, card);
      const paymentId = nextPaymentId();
      if (!isThreeD(input)) {
        const response = { ...result, paymentId, merchantPaymentId: input.merchantPaymentId, amount: input.amount || input.paymentAmount, currency: input.currency || 'TRY', paymentInstrument: input.paymentInstrument };
        if (result.result === 'Success') payments.set(paymentId, { provider: 'lidio', input, result });
        return json(res, 200, response);
      }
      payments.set(paymentId, { provider: 'lidio', input, result, threeD: true });
      return json(res, 200, { result: 'RedirectRequired', paymentId, RedirectForm: threeDsHtml(paymentId, mountPath) });
    }
    if (FINISH_PATHS.has(pathname)) {
      const input = await payload(req);
      const paymentId = String(input?.paymentId || input?.PaymentId || '');
      const payment = payments.get(paymentId);
      if (!payment || payment.provider !== 'lidio') return json(res, 404, { result: 'Failed', errorCode: 'PaymentNotFound', errorMessage: 'Payment not found' });
      const result = payment.threeDCompleted ? payment.result : { result: 'Failed', errorCode: 'ThreeDSecureNotCompleted', errorMessage: '3D Secure authentication is not complete' };
      return json(res, 200, { ...result, paymentId, merchantPaymentId: payment.input.merchantPaymentId, amount: payment.input.amount || payment.input.paymentAmount, currency: payment.input.currency || 'TRY' });
    }
    const match = pathname.match(/^\/lidio\/3ds\/([^/]+)$/);
    if (!match) return false;
    const payment = payments.get(match[1]);
    if (!payment?.threeD) return text(res, 404, 'Unknown payment');
    const values = await form(req);
    payment.threeDCompleted = values.code === '123456';
    const returnUrl = payment.input.returnUrl || payment.input.ReturnUrl;
    if (!returnUrl) return text(res, 200, payment.threeDCompleted ? '3D Secure completed' : '3D Secure failed');
    const url = new URL(returnUrl); url.searchParams.set('paymentId', match[1]); url.searchParams.set('result', payment.threeDCompleted ? 'Success' : 'Failed');
    res.writeHead(302, { location: url.toString() }); res.end(); return true;
  }
  return { handles: (pathname) => PROCESS_PATHS.has(pathname) || FINISH_PATHS.has(pathname) || /^\/lidio\/3ds\/[^/]+$/.test(pathname), handle };
}
