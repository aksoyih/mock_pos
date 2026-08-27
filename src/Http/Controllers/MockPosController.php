<?php

namespace Haluk\MockPos\Http\Controllers;

use Haluk\MockPos\PaymentStore;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Routing\Controller;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/** A deliberately local-only mock. Never expose these routes in production. */
class MockPosController extends Controller
{
    public function __construct(private readonly PaymentStore $payments) {}

    public function health(): \Illuminate\Http\JsonResponse { return response()->json(['status' => 'ok']); }

    public function handle(Request $request, string $provider, ?string $path = null): Response|\Illuminate\Http\JsonResponse
    {
        return match ($provider) {
            'paytr' => $this->paytr($request, '/'.ltrim((string) $path, '/')),
            'iyzico' => $this->iyzico($request, '/'.ltrim((string) $path, '/')),
            'lidio' => $this->lidio($request, '/'.ltrim((string) $path, '/')),
            'garanti' => $this->garanti($request, '/'.ltrim((string) $path, '/')),
            default => response()->json(['error' => "Unknown provider: {$provider}"], 404),
        };
    }

    private function failed(Request $request, string $card = ''): bool
    {
        $forced = $request->header('X-Mock-Payment-Outcome');
        return in_array($forced, ['failure', 'fail'], true)
            || ($forced !== 'success' && config('mock-pos.payment_outcome') === 'failure')
            || ($forced !== 'success' && str_ends_with(str_replace(' ', '', $card), '0000'));
    }

    private function paytr(Request $request, string $path): Response|\Illuminate\Http\JsonResponse
    {
        if ($path === '/odeme') {
            if (!$request->isMethod('post')) return response('Method not allowed', 405);
            $p = $request->all();
            $missing = $this->missing($p, ['merchant_id','paytr_token','user_ip','merchant_oid','email','payment_amount','payment_type','installment_count','non_3d','user_address','user_phone','user_basket']);
            if ($missing) return response('Missing required fields: '.implode(', ', $missing), 400);
            if (!$this->validPaytrToken($p)) return response('Invalid paytr_token', 400);
            $result = $this->paytrResult($request, $p);
            if ((string) $p['non_3d'] === '1') return $this->completePaytr($p, $result);
            $id = (string) Str::uuid(); $this->payments->put($id, ['provider' => 'paytr', 'request' => $p, 'result' => $result]);
            return response($this->threeDsPage('PayTR', '123456', "/providers/paytr/paytr/3ds/{$id}"), 200, ['Content-Type' => 'text/html; charset=utf-8']);
        }
        if (preg_match('#^/paytr/3ds/([^/]+)$#', $path, $matches) && $request->isMethod('post')) {
            $payment = $this->payments->get($matches[1]);
            if (!$payment || $payment['provider'] !== 'paytr') return response('Unknown payment', 404);
            $result = $payment['result']['status'] === 'success' && $request->input('code') === '123456' ? $payment['result'] : ['status' => 'failed', 'code' => '2', 'message' => 'Authentication failed'];
            return $this->completePaytr($payment['request'], $result);
        }
        if (in_array($path, ['/odeme/iade', '/odeme/iptal'], true) && $request->isMethod('post')) return $this->paytrReversal($request, $path);
        return response('Not found', 404);
    }

    private function paytrResult(Request $request, array $p): array
    {
        $errors = ['900'=>['0','Mock card declined'],'901'=>['1','Authentication not performed'],'902'=>['2','Authentication failed'],'903'=>['3','Security check declined'],'906'=>['6','Customer abandoned payment'],'908'=>['8','Installment not permitted'],'909'=>['9','Card not authorized'],'910'=>['10','3D Secure is required'],'911'=>['11','Security alert'],'999'=>['99','Technical integration error']];
        if (isset($errors[$p['cvv'] ?? ''])) return ['status'=>'failed','code'=>$errors[$p['cvv']][0],'message'=>$errors[$p['cvv']][1]];
        return $this->failed($request, $p['card_number'] ?? '') || ($p['non3d_test_failed'] ?? '') === '1' ? ['status'=>'failed','code'=>'0','message'=>'Mock card declined'] : ['status'=>'success'];
    }

    private function completePaytr(array $p, array $result): Response|\Illuminate\Http\JsonResponse
    {
        if ($result['status'] === 'success') $this->payments->put('paytr:'.$p['merchant_oid'], ['provider'=>'paytr','request'=>$p,'amount'=>(float) $p['payment_amount'],'refunded'=>0,'cancelled'=>false]);
        $this->callbackPaytr($p, $result);
        if (($p['sync_mode'] ?? '') === '1') return response()->json($result['status'] === 'success' ? ['status'=>'success','msg'=>'Successful Payment.','utoken'=>'mock-utoken','ctoken'=>'mock-ctoken'] : ['status'=>'failed','msg'=>$result['message']]);
        $destination = $result['status'] === 'success' ? ($p['merchant_ok_url'] ?? null) : ($p['merchant_fail_url'] ?? null);
        if (!$destination) return response($result['status'] === 'success' ? 'Payment successful' : 'Payment failed');
        if ($result['status'] === 'failed') $destination .= (str_contains($destination, '?') ? '&' : '?').'fail_message='.urlencode($result['message']);
        return redirect()->away($destination);
    }

    private function paytrReversal(Request $request, string $path): \Illuminate\Http\JsonResponse
    {
        $input = $request->all(); $key = 'paytr:'.($input['merchant_oid'] ?? ''); $payment = $this->payments->get($key);
        if (!$payment) return response()->json(['status'=>'failed','err_no'=>'005','err_msg'=>'merchant_oid ile basarili odeme bulunamadi']);
        if ($path === '/odeme/iptal') { if ($payment['cancelled'] || $payment['refunded']) return response()->json(['status'=>'failed','err_no'=>'005','err_msg'=>'Payment cannot be cancelled']); $payment['cancelled']=true; $this->payments->update($key,$payment); return response()->json(['status'=>'success','merchant_oid'=>$input['merchant_oid'],'cancelled'=>true]); }
        $amount = (float) ($input['return_amount'] ?? 0);
        if ($amount <= 0 || $payment['cancelled'] || $payment['refunded'] + $amount > $payment['amount']) return response()->json(['status'=>'failed','err_no'=>'009','err_msg'=>'Toplam iade tutari odeme tutarindan fazla olamaz']);
        $payment['refunded'] += $amount; $this->payments->update($key,$payment);
        return response()->json(['status'=>'success','is_test'=>'1','merchant_oid'=>$input['merchant_oid'],'return_amount'=>$input['return_amount']]);
    }

    private function iyzico(Request $request, string $path): \Illuminate\Http\JsonResponse
    {
        if (!str_starts_with((string) $request->header('Authorization'), 'IYZWSv2 ')) return response()->json(['status'=>'failure','errorCode'=>'401','errorMessage'=>'Authorization header must start with IYZWSv2'], 401);
        $input = $request->json()->all() ?: $request->all();
        if ($path === '/payment/auth') return $this->iyziAuthorize($request, $input);
        if ($path === '/payment/3dsecure/initialize') return $this->iyziInitialize($request, $input);
        if (preg_match('#^/iyzico/3ds/([^/]+)$#', $path, $matches) && $request->isMethod('post')) {
            $payment = $this->payments->get('iyzi:'.$matches[1]);
            if (!$payment || empty($payment['threeD'])) return response()->json(['status'=>'failure','errorCode'=>'404','errorMessage'=>'Payment not found'], 404);
            $success = $request->input('code') === '123456' && $payment['result']['status'] === 'success';
            $url = $payment['input']['callbackUrl'] ?? null;
            if (!$url) return response()->json(['status'=>$success ? 'success' : 'failure','paymentId'=>$matches[1]]);
            return response()->json(['redirectUrl'=>$url.(str_contains($url,'?')?'&':'?').'paymentId='.$matches[1].'&conversationData=mock-conversation-data&status='.($success?'success':'failure')]);
        }
        if (in_array($path, ['/payment/3dsecure/auth','/payment/v2/3dsecure/auth'], true)) return $this->iyziComplete($input);
        if (in_array($path, ['/payment/cancel','/payment/refund','/v2/payment/refund'], true)) return $this->iyziReversal($input, $path);
        return response()->json(['status'=>'failure','errorCode'=>'404','errorMessage'=>'Not found'], 404);
    }

    private function iyziAuthorize(Request $request, array $input): \Illuminate\Http\JsonResponse
    {
        $missing = $this->missing($input, ['price','paidPrice','paymentCard','buyer','billingAddress','basketItems']);
        if ($missing) return response()->json(['status'=>'failure','errorCode'=>'400','errorMessage'=>'Missing required fields: '.implode(', ', $missing)],400);
        $result = $this->iyziResult($request, $input); if ($result['status'] !== 'success') return response()->json($this->iyziFailure($input,$result));
        $response = $this->iyziBase($input); $this->payments->put('iyzi:'.$response['paymentId'], ['provider'=>'iyzico','amount'=>(float)$input['paidPrice'],'refunded'=>0,'cancelled'=>false,'response'=>$response]); return response()->json($response);
    }

    private function iyziInitialize(Request $request, array $input): \Illuminate\Http\JsonResponse
    {
        $result=$this->iyziResult($request,$input); if (($result['initFail'] ?? false) || $result['status'] !== 'success') return response()->json($this->iyziFailure($input,$result));
        $id=$this->payments->nextId(); $this->payments->put('iyzi:'.$id,['provider'=>'iyzico','input'=>$input,'result'=>$result,'threeD'=>true]);
        $html=$this->threeDsPage('iyzico','123456',"/providers/iyzico/iyzico/3ds/{$id}");
        return response()->json(['status'=>'success','locale'=>$input['locale'] ?? 'tr','systemTime'=>(int)(microtime(true)*1000),'conversationId'=>$input['conversationId'] ?? null,'paymentId'=>$id,'threeDSHtmlContent'=>base64_encode($html)]);
    }

    private function iyziComplete(array $input): \Illuminate\Http\JsonResponse
    {
        $id=(string)($input['paymentId'] ?? ''); $payment=$this->payments->get('iyzi:'.$id); if (!$payment || empty($payment['threeD'])) return response()->json($this->iyziFailure($input,['code'=>'404','message'=>'Payment not found','group'=>'NOT_FOUND']),404);
        $response=$this->iyziBase($payment['input']); $response['paymentId']=$id; $response['mdStatus']=1; $this->payments->update('iyzi:'.$id,['provider'=>'iyzico','amount'=>(float)$payment['input']['paidPrice'],'refunded'=>0,'cancelled'=>false,'response'=>$response]); return response()->json($response);
    }

    private function iyziReversal(array $input, string $path): \Illuminate\Http\JsonResponse
    {
        $id=(string)($input['paymentId'] ?? ''); if (!$id && isset($input['paymentTransactionId'])) $id=(string)strrchr((string)$input['paymentTransactionId'], '-');
        $key='iyzi:'.$id; $payment=$this->payments->get($key); if (!$payment || $payment['cancelled']) return response()->json(['status'=>'failure','errorCode'=>'404','errorMessage'=>'Payment not found']);
        if ($path==='/payment/cancel') { if ($payment['refunded']) return response()->json(['status'=>'failure','errorCode'=>'400','errorMessage'=>'Payment cannot be cancelled']); $payment['cancelled']=true; $this->payments->update($key,$payment); return response()->json(['status'=>'success','paymentId'=>$id]); }
        $amount=(float)($input['price'] ?? 0); if ($amount<=0 || $payment['refunded']+$amount>$payment['amount']) return response()->json(['status'=>'failure','errorCode'=>'400','errorMessage'=>'Refund exceeds remaining amount']); $payment['refunded']+=$amount; $this->payments->update($key,$payment); return response()->json(['status'=>'success','paymentId'=>$id,'price'=>(string)$amount]);
    }

    private function iyziResult(Request $request, array $input): array
    {
        $card = str_replace(' ', '', (string) data_get($input, 'paymentCard.cardNumber'));
        if ($card === '4131111111111117') return ['status'=>'success','mdStatus'=>0];
        if ($card === '4141111111111115') return ['status'=>'success','mdStatus'=>4];
        if ($card === '4151111111111112') return ['status'=>'failure','code'=>'10202','group'=>'INIT_3DS','message'=>'3D Secure initialization failed','initFail'=>true];
        $errors=['4111111111111129'=>['10051','NOT_SUFFICIENT_FUNDS','Insufficient card limit, insufficient balance'],'4129111111111111'=>['10005','DO_NOT_HONOUR','Transaction not approved'],'4128111111111112'=>['10012','INVALID_TRANSACTION','Invalid transaction'],'4127111111111113'=>['10043','LOST_CARD','Lost card'],'4126111111111114'=>['10043','STOLEN_CARD','Stolen card'],'4125111111111115'=>['10054','EXPIRED_CARD','Expiry date incorrect'],'4124111111111116'=>['10084','INVALID_CVC2','Incorrect CVC2 information'],'4123111111111117'=>['10057','NOT_PERMITTED_TO_CARDHOLDER','Cardholder cannot perform this transaction'],'4122111111111118'=>['10058','NOT_PERMITTED_TO_TERMINAL','Terminal not authorized for this transaction'],'4121111111111119'=>['10034','FRAUD_SUSPECT','Payment failed to pass security check'],'4120111111111110'=>['10041','PICKUP_CARD','Pickup card'],'4130111111111118'=>['10202','UNKNOWN','A general error occurred during the payment process']];
        $cvvErrors=['005'=>['10005','DO_NOT_HONOUR','Transaction not approved'],'051'=>['10051','NOT_SUFFICIENT_FUNDS','Insufficient card limit, insufficient balance'],'054'=>['10054','EXPIRED_CARD','Expiry date incorrect'],'084'=>['10084','INVALID_CVC2','Incorrect CVC2 information'],'034'=>['10034','FRAUD_SUSPECT','Payment failed to pass security check'],'220'=>['10220','DECLINED','Payment not accepted']];
        $error=$errors[$card] ?? $cvvErrors[(string)data_get($input,'paymentCard.cvc')] ?? null;
        if ($error) return ['status'=>'failure','code'=>$error[0],'group'=>$error[1],'message'=>$error[2]];
        return $this->failed($request,$card) ? ['status'=>'failure','code'=>'10051','group'=>'NOT_SUFFICIENT_FUNDS','message'=>'Insufficient funds'] : ['status'=>'success'];
    }

    private function iyziBase(array $input): array
    {
        $card=(array)($input['paymentCard'] ?? []); $id=$this->payments->nextId();
        return ['status'=>'success','locale'=>$input['locale'] ?? 'tr','systemTime'=>(int)(microtime(true)*1000),'conversationId'=>$input['conversationId'] ?? null,'price'=>(string)($input['price'] ?? ''),'paidPrice'=>(string)($input['paidPrice'] ?? ''),'installment'=>$input['installment'] ?? 1,'paymentId'=>$id,'fraudStatus'=>1,'merchantCommissionRate'=>0,'merchantCommissionRateAmount'=>0,'iyziCommissionRateAmount'=>0,'iyziCommissionFee'=>0.25,'cardType'=>'CREDIT_CARD','cardAssociation'=>str_starts_with((string)($card['cardNumber'] ?? ''),'4') ? 'VISA' : 'MASTER_CARD','cardFamily'=>'Mock Card','binNumber'=>substr((string)($card['cardNumber'] ?? ''),0,6),'lastFourDigits'=>substr((string)($card['cardNumber'] ?? ''),-4),'basketId'=>$input['basketId'] ?? null,'currency'=>$input['currency'] ?? 'TRY','itemTransactions'=>array_map(fn($item,$index)=>['itemId'=>$item['id'] ?? null,'paymentTransactionId'=>'mock-tx-'.($index+1).'-'.$id,'transactionStatus'=>2,'price'=>(string)($item['price'] ?? ''),'paidPrice'=>(string)($item['price'] ?? ''),'commission'=>0,'iyziCommissionFee'=>0.25,'iyziCommissionRateAmount'=>0,'merchantCommissionRate'=>0,'merchantCommissionRateAmount'=>0], $input['basketItems'] ?? [], array_keys($input['basketItems'] ?? []))];
    }

    private function iyziFailure(array $input, array $result=[]): array { return ['status'=>'failure','locale'=>$input['locale'] ?? 'tr','systemTime'=>(int)(microtime(true)*1000),'conversationId'=>$input['conversationId'] ?? null,'errorCode'=>$result['code'] ?? '10051','errorMessage'=>$result['message'] ?? 'Insufficient funds','errorGroup'=>$result['group'] ?? 'NOT_SUFFICIENT_FUNDS']; }

    private function lidio(Request $request, string $path): Response|\Illuminate\Http\JsonResponse
    {
        if (!$request->isMethod('post')) return response()->json(['result'=>'Failed','errorCode'=>'MethodNotAllowed','errorMessage'=>'Method not allowed'],405);
        $process=['/ProcessPayment','/Payment/ProcessPayment','/api/Payment/ProcessPayment']; $finish=['/FinishPaymentProcess','/Payment/FinishPaymentProcess','/api/Payment/FinishPaymentProcess']; $cancel=['/CancelPayment','/Payment/CancelPayment']; $refund=['/RefundPayment','/Payment/RefundPayment'];
        if (in_array($path,$process,true)) {
            $input=$request->json()->all() ?: $request->all(); if (empty($input['paymentInstrument']) || empty($input['paymentInstrumentInfo'])) return response()->json(['result'=>'Failed','errorCode'=>'ValidationError','errorMessage'=>'paymentInstrument and paymentInstrumentInfo are required'],400);
            if (strtolower((string)$input['paymentInstrument']) !== 'newcard') return response()->json(['result'=>'Failed','errorCode'=>'UnsupportedInstrument','errorMessage'=>'Only NewCard payments are mocked'],400);
            $card=data_get($input,'paymentInstrumentInfo.newCard',data_get($input,'paymentInstrumentInfo.card',[])); if (empty($card['cardNumber'])) return response()->json(['result'=>'Failed','errorCode'=>'ValidationError','errorMessage'=>'paymentInstrumentInfo.newCard.cardNumber is required'],400);
            $result=$this->lidioResult($request,$card); $id=$this->payments->nextId(); $threeD=in_array(strtoupper((string)($input['paymentType'] ?? $input['paymentSecurity'] ?? $input['paymentModel'] ?? '')),['3D','3DS','THREEDS'],true) || !empty($input['is3DSecure']) || !empty($input['threeDSecure']);
            if (!$threeD) { $response=$this->lidioResponse($result,$id,$input); if ($result['result']==='Success') $this->payments->put('lidio:'.$id,['provider'=>'lidio','input'=>$input,'result'=>$result,'refunded'=>0,'cancelled'=>false]); return response()->json($response); }
            $this->payments->put('lidio:'.$id,['provider'=>'lidio','input'=>$input,'result'=>$result,'threeD'=>true]); return response()->json(['result'=>'RedirectRequired','paymentId'=>$id,'RedirectForm'=>$this->threeDsPage('Lidio','123456',"/providers/lidio/lidio/3ds/{$id}")]);
        }
        if (in_array($path,$finish,true)) { $input=$request->json()->all() ?: $request->all(); $id=(string)($input['paymentId'] ?? $input['PaymentId'] ?? ''); $payment=$this->payments->get('lidio:'.$id); if (!$payment) return response()->json(['result'=>'Failed','errorCode'=>'PaymentNotFound','errorMessage'=>'Payment not found'],404); return response()->json($this->lidioResponse($payment['threeDCompleted'] ?? false ? $payment['result'] : ['result'=>'Failed','errorCode'=>'ThreeDSecureNotCompleted','errorMessage'=>'3D Secure authentication is not complete'],$id,$payment['input'])); }
        if (in_array($path,$cancel,true) || in_array($path,$refund,true)) { $input=$request->json()->all() ?: $request->all(); $id=(string)($input['paymentId'] ?? $input['PaymentId'] ?? ''); $key='lidio:'.$id; $payment=$this->payments->get($key); if (!$payment || $payment['cancelled']) return response()->json(['result'=>'Failed','errorCode'=>'PaymentNotFound','errorMessage'=>'Payment not found'],404); $total=(float)($payment['input']['amount'] ?? $payment['input']['paymentAmount'] ?? 0); if (in_array($path,$cancel,true)) { if ($payment['refunded']) return response()->json(['result'=>'Failed','errorCode'=>'PaymentNotCancellable','errorMessage'=>'Payment has refunds'],400); $payment['cancelled']=true; $this->payments->update($key,$payment); return response()->json(['result'=>'Success','paymentId'=>$id,'cancelled'=>true]); } $amount=(float)($input['amount'] ?? $input['refundAmount'] ?? 0); if ($amount<=0 || $payment['refunded']+$amount>$total) return response()->json(['result'=>'Failed','errorCode'=>'InvalidRefundAmount','errorMessage'=>'Refund exceeds remaining amount'],400); $payment['refunded']+=$amount; $this->payments->update($key,$payment); return response()->json(['result'=>'Success','paymentId'=>$id,'refundAmount'=>$amount,'remainingAmount'=>$total-$payment['refunded']]); }
        if (preg_match('#^/lidio/3ds/([^/]+)$#',$path,$m)) { $key='lidio:'.$m[1]; $payment=$this->payments->get($key); if (!$payment) return response('Unknown payment',404); $payment['threeDCompleted']=$request->input('code')==='123456'; $this->payments->update($key,$payment); $url=$payment['input']['returnUrl'] ?? $payment['input']['ReturnUrl'] ?? null; if (!$url) return response($payment['threeDCompleted']?'3D Secure completed':'3D Secure failed'); return redirect()->away($url.(str_contains($url,'?')?'&':'?').'paymentId='.$m[1].'&result='.($payment['threeDCompleted']?'Success':'Failed')); }
        return response()->json(['result'=>'Failed','errorCode'=>'NotFound','errorMessage'=>'Not found'],404);
    }

    private function lidioResult(Request $request, array $card): array { if ($this->failed($request,$card['cardNumber'] ?? '') || ($card['cvv'] ?? '')==='051') return ['result'=>'Failed','errorCode'=>'InsufficientFunds','errorMessage'=>'Insufficient funds']; if (($card['cvv'] ?? '')==='084') return ['result'=>'Failed','errorCode'=>'InvalidCvv','errorMessage'=>'Invalid CVV']; return ['result'=>'Success']; }
    private function lidioResponse(array $result,string $id,array $input): array { return $result+['paymentId'=>$id,'merchantPaymentId'=>$input['merchantPaymentId'] ?? null,'amount'=>$input['amount'] ?? $input['paymentAmount'] ?? null,'currency'=>$input['currency'] ?? 'TRY','paymentInstrument'=>$input['paymentInstrument'] ?? null]; }

    private function garanti(Request $request, string $path): Response
    {
        if ($path === '/VPServlet') {
            if (!$request->isMethod('post')) return response('Method not allowed',405);
            $xml=$request->getContent(); $order=$this->xmlTag($xml,'OrderID'); $card=$this->xmlTag($xml,'Number'); $amount=$this->xmlTag($xml,'Amount'); $type=strtolower($this->xmlTag($xml,'Type')); $key='garanti:'.$order; $payment=$this->payments->get($key);
            if (in_array($type,['refund','cancel'],true)) { if (!$payment || $payment['cancelled']) return $this->garantiXml($order,'',false,'Payment not found'); if ($type==='cancel') { if ($payment['refunded']) return $this->garantiXml($order,'',false,'Payment cannot be cancelled'); $payment['cancelled']=true; $this->payments->update($key,$payment); return $this->garantiXml($order,$payment['card'],true); } $refund=(float)$amount; if ($refund<=0 || $payment['refunded']+$refund>$payment['amount']) return $this->garantiXml($order,$payment['card'],false,'Refund exceeds remaining amount'); $payment['refunded']+=$refund; $this->payments->update($key,$payment); return $this->garantiXml($order,$payment['card'],true); }
            if (!$order || !$card || !$amount) return $this->garantiXml($order,$card,false,'Required transaction fields are missing'); $fail=$this->failed($request,$card); if (!$fail) $this->payments->put($key,['provider'=>'garanti','amount'=>(float)$amount,'card'=>$card,'refunded'=>0,'cancelled'=>false]); return $this->garantiXml($order,$card,!$fail,$fail?'Insufficient funds':'Approved');
        }
        if ($path === '/servlet/gt3dengine') { if (!$request->isMethod('post')) return response('Method not allowed',405); $input=$request->all(); $missing=$this->missing($input,['orderid','cardnumber','txnamount','successurl','errorurl']); if ($missing) return response('Missing required fields: '.implode(', ',$missing),400); $id=(string)Str::uuid(); $this->payments->put('garanti-3ds:'.$id,['input'=>$input,'failed'=>$this->failed($request,$input['cardnumber'])]); return response($this->threeDsPage('Garanti BBVA','147852',"/providers/garanti/garanti/3ds/{$id}"),200,['Content-Type'=>'text/html; charset=utf-8']); }
        if (preg_match('#^/garanti/3ds/([^/]+)$#',$path,$m) && $request->isMethod('post')) { $payment=$this->payments->get('garanti-3ds:'.$m[1]); if (!$payment) return response('Unknown payment',404); $success=!$payment['failed'] && $request->input('otp')==='147852'; $input=$payment['input']; $fields=['mdstatus'=>$success?'1':'0','mderrormessage'=>$success?'Authenticated':'Authentication failed','errmsg'=>$success?'':'Authentication failed','response'=>$success?'Approved':'Error','procreturncode'=>$success?'00':'99','oid'=>$input['orderid'],'orderid'=>$input['orderid'],'txnamount'=>$input['txnamount'],'txncurrencycode'=>$input['txncurrencycode'] ?? '949','secure3dsecuritylevel'=>$input['secure3dsecuritylevel'] ?? '3D_PAY']; return response($this->callbackForm($success?$input['successurl']:$input['errorurl'],$fields),200,['Content-Type'=>'text/html; charset=utf-8']); }
        return response('Not found',404);
    }

    private function garantiXml(string $order, string $card, bool $success, string $message='Approved'): Response
    {
        $code=$success?'00':'51'; $masked=$card ? substr($card,0,6).'******'.substr($card,-4) : '';
        $xml='<?xml version="1.0" encoding="ISO-8859-9"?><GVPSResponse><Mode>TEST</Mode><Order><OrderID>'.$this->escape($order).'</OrderID></Order><Transaction><Response><Source>HOST</Source><Code>'.$code.'</Code><ReasonCode>'.$code.'</ReasonCode><Message>'.$this->escape($message).'</Message><ErrorMsg>'.($success?'':$this->escape($message)).'</ErrorMsg><SysErrMsg></SysErrMsg></Response><RetrefNum>mock'.((int)(microtime(true)*1000)).'</RetrefNum><AuthCode>'.($success?'123456':'').'</AuthCode><BatchNum>000001</BatchNum><SequenceNum>000001</SequenceNum><CardNumberMasked>'.$this->escape($masked).'</CardNumberMasked><CardType>BONUS</CardType></Transaction></GVPSResponse>';
        return response($xml,200,['Content-Type'=>'application/xml; charset=iso-8859-9']);
    }

    private function callbackPaytr(array $p,array $result): void
    {
        $target=config('mock-pos.paytr.callback_url'); if (!$target) return; $status=$result['status']; $total=$status==='success' ? (string)round((float)$p['payment_amount']*100) : '0'; $data=['merchant_oid'=>$p['merchant_oid'],'status'=>$status,'total_amount'=>$total,'payment_amount'=>(string)round((float)$p['payment_amount']*100),'test_mode'=>$p['test_mode'] ?? '1','payment_type'=>'card','currency'=>$p['currency'] ?? 'TL','installment_count'=>$p['installment_count'] ?? '0']; if ($status==='failed') $data += ['failed_reason_code'=>$result['code'] ?? '0','failed_reason_msg'=>$result['message'] ?? 'Mock card declined']; if (config('mock-pos.paytr.merchant_key') && config('mock-pos.paytr.merchant_salt')) $data['hash']=$this->paytrHash($p['merchant_oid'].config('mock-pos.paytr.merchant_salt').$status.$total); Http::asForm()->post($target,$data);
    }
    private function validPaytrToken(array $p): bool { if (!config('mock-pos.paytr.merchant_key') || !config('mock-pos.paytr.merchant_salt')) return true; $source=($p['merchant_id'].$p['user_ip'].$p['merchant_oid'].$p['email'].$p['payment_amount'].$p['payment_type'].$p['installment_count'].($p['currency'] ?? 'TL').($p['test_mode'] ?? '0').$p['non_3d']).config('mock-pos.paytr.merchant_salt'); return hash_equals($this->paytrHash($source),(string)$p['paytr_token']); }
    private function paytrHash(string $data): string { return base64_encode(hash_hmac('sha256',$data,(string)config('mock-pos.paytr.merchant_key'),true)); }
    private function threeDsPage(string $provider,string $code,string $action): string { return '<!doctype html><html><body><h1>Mock '.$this->escape($provider).' 3D Secure</h1><p>Enter <b>'.$code.'</b> to approve.</p><form method="post" action="'.$this->escape($action).'"><label>Verification code <input name="'.($provider==='Garanti BBVA'?'otp':'code').'" autofocus></label><button>Complete payment</button></form></body></html>'; }
    private function callbackForm(string $url,array $fields): string { $inputs=''; foreach($fields as $key=>$value) $inputs.='<input type="hidden" name="'.$this->escape($key).'" value="'.$this->escape((string)$value).'">'; return '<!doctype html><html><body><form id="result" method="post" action="'.$this->escape($url).'">'.$inputs.'</form><script>document.getElementById("result").submit()</script></body></html>'; }
    private function missing(array $input,array $fields): array { return array_values(array_filter($fields,fn($field)=>!array_key_exists($field,$input) || ($input[$field] !== 0 && $input[$field] !== '0' && !$input[$field]))); }
    private function xmlTag(string $xml,string $tag): string { return preg_match('#<'.$tag.'>(.*?)</'.$tag.'>#is',$xml,$m) ? trim(html_entity_decode($m[1])) : ''; }
    private function escape(string $value): string { return htmlspecialchars($value,ENT_XML1|ENT_QUOTES,'UTF-8'); }
}
