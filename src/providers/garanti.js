import { randomUUID } from 'node:crypto';

const XML_PATH = '/VPServlet';
const THREE_D_PATH = '/servlet/gt3dengine';
function tag(xml, name) { return xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]?.trim() || ''; }
function escape(value = '') { return String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char])); }
function responseXml({ orderId, card, success, message = 'Approved' }) {
  const code = success ? '00' : '51';
  return `<?xml version="1.0" encoding="ISO-8859-9"?><GVPSResponse><Mode>TEST</Mode><Order><OrderID>${escape(orderId)}</OrderID></Order><Transaction><Response><Source>HOST</Source><Code>${code}</Code><ReasonCode>${code}</ReasonCode><Message>${escape(message)}</Message><ErrorMsg>${success ? '' : escape(message)}</ErrorMsg><SysErrMsg></SysErrMsg></Response><RetrefNum>mock${Date.now()}</RetrefNum><AuthCode>${success ? '123456' : ''}</AuthCode><BatchNum>000001</BatchNum><SequenceNum>000001</SequenceNum><CardNumberMasked>${escape(card.slice(0, 6))}******${escape(card.slice(-4))}</CardNumberMasked><CardType>BONUS</CardType></Transaction></GVPSResponse>`;
}
function hostedPage(id, mountPath) { return `<!doctype html><html><body><h1>Mock Garanti BBVA 3D Secure</h1><p>Enter the official test OTP <b>147852</b> to approve.</p><form method="post" action="${mountPath}/garanti/3ds/${id}"><label>OTP <input name="otp" autofocus></label><button>Complete payment</button></form></body></html>`; }
function callbackForm(url, fields) { return `<!doctype html><html><body><form id="result" method="post" action="${escape(url)}">${Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join('')}</form><script>document.getElementById('result').submit()</script></body></html>`; }

export function createGarantiHandler({ payments, text, body, form }) {
  async function handle(req, res, pathname, mountPath) {
    if (pathname === XML_PATH) {
      if (req.method !== 'POST') return text(res, 405, 'Method not allowed');
      const input = await body(req); const orderId = tag(input, 'OrderID'); const card = tag(input, 'Number'); const amount = tag(input, 'Amount');
      const type = tag(input, 'Type').toLowerCase(); const existing = payments.get(`garanti:${orderId}`);
      if (type === 'refund' || type === 'cancel') {
        if (!existing || existing.cancelled) return text(res, 200, responseXml({ orderId, card: '', success: false, message: 'Payment not found' }), { 'content-type': 'application/xml; charset=iso-8859-9' });
        if (type === 'cancel') { if (existing.refunded) return text(res, 200, responseXml({ orderId, card: '', success: false, message: 'Payment cannot be cancelled' }), { 'content-type': 'application/xml; charset=iso-8859-9' }); existing.cancelled = true; return text(res, 200, responseXml({ orderId, card: existing.card, success: true, message: 'Approved' }), { 'content-type': 'application/xml; charset=iso-8859-9' }); }
        const refund = Number(amount); existing.refunded ??= 0; if (!(refund > 0) || existing.refunded + refund > existing.amount) return text(res, 200, responseXml({ orderId, card: existing.card, success: false, message: 'Refund exceeds remaining amount' }), { 'content-type': 'application/xml; charset=iso-8859-9' }); existing.refunded += refund; return text(res, 200, responseXml({ orderId, card: existing.card, success: true, message: 'Approved' }), { 'content-type': 'application/xml; charset=iso-8859-9' });
      }
      if (!orderId || !card || !amount) return text(res, 200, responseXml({ orderId, card, success: false, message: 'Required transaction fields are missing' }), { 'content-type': 'application/xml; charset=iso-8859-9' });
      const failed = String(req.headers['x-mock-payment-outcome']) === 'failure' || card.replace(/\s/g, '').endsWith('0000');
      if (!failed) payments.set(`garanti:${orderId}`, { provider: 'garanti', amount: Number(amount), card, refunded: 0, cancelled: false });
      return text(res, 200, responseXml({ orderId, card, success: !failed, message: failed ? 'Insufficient funds' : 'Approved' }), { 'content-type': 'application/xml; charset=iso-8859-9' });
    }
    if (pathname === THREE_D_PATH) {
      if (req.method !== 'POST') return text(res, 405, 'Method not allowed');
      const input = await form(req); const missing = ['orderid', 'cardnumber', 'txnamount', 'successurl', 'errorurl'].filter((key) => !input[key]);
      if (missing.length) return text(res, 400, `Missing required fields: ${missing.join(', ')}`);
      const id = randomUUID(); payments.set(id, { provider: 'garanti', input, failed: input.cardnumber.replace(/\s/g, '').endsWith('0000') || req.headers['x-mock-payment-outcome'] === 'failure' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(hostedPage(id, mountPath)); return;
    }
    const match = pathname.match(/^\/garanti\/3ds\/([^/]+)$/);
    if (!match || req.method !== 'POST') return false;
    const payment = payments.get(match[1]); if (!payment?.input) return text(res, 404, 'Unknown payment');
    const values = await form(req); const success = !payment.failed && values.otp === '147852'; const input = payment.input;
    const url = success ? input.successurl : input.errorurl;
    return text(res, 200, callbackForm(url, { mdstatus: success ? '1' : '0', mderrormessage: success ? 'Authenticated' : 'Authentication failed', errmsg: success ? '' : 'Authentication failed', response: success ? 'Approved' : 'Error', procreturncode: success ? '00' : '99', oid: input.orderid, orderid: input.orderid, txnamount: input.txnamount, txncurrencycode: input.txncurrencycode || '949', secure3dsecuritylevel: input.secure3dsecuritylevel || '3D_PAY' }), { 'content-type': 'text/html; charset=utf-8' });
  }
  return { handles: (pathname) => [XML_PATH, THREE_D_PATH].includes(pathname) || /^\/garanti\/3ds\/[^/]+$/.test(pathname), handle };
}
