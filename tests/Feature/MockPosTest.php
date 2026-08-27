<?php

namespace Haluk\MockPos\Tests\Feature;

use Haluk\MockPos\MockPosServiceProvider;
use Orchestra\Testbench\TestCase;

class MockPosTest extends TestCase
{
    protected function getPackageProviders($app): array { return [MockPosServiceProvider::class]; }

    public function test_health_endpoint_is_available(): void
    {
        $this->get('/health')->assertOk()->assertJson(['status' => 'ok']);
    }

    public function test_paytr_non_3d_success_has_provider_response(): void
    {
        $this->post('/providers/paytr/odeme', ['merchant_id'=>'1','paytr_token'=>'mock','user_ip'=>'127.0.0.1','merchant_oid'=>'order-1','email'=>'buyer@example.test','payment_amount'=>'10.50','payment_type'=>'card','installment_count'=>'0','non_3d'=>'1','user_address'=>'Istanbul','user_phone'=>'555','user_basket'=>'[]','sync_mode'=>'1'])->assertOk()->assertJson(['status'=>'success']);
    }

    public function test_unknown_providers_are_rejected(): void
    {
        $this->post('/providers/other/payment/auth')->assertNotFound()->assertJsonPath('error','Unknown provider: other');
    }

    public function test_other_provider_payment_surfaces_are_available(): void
    {
        $iyzico = ['price'=>10,'paidPrice'=>10,'paymentCard'=>['cardNumber'=>'5528790000000008','cvc'=>'123'],'buyer'=>['id'=>'buyer-1'],'billingAddress'=>['city'=>'Istanbul'],'basketItems'=>[['id'=>'item-1','price'=>10]]];
        $this->withHeader('Authorization', 'IYZWSv2 test')->postJson('/providers/iyzico/payment/auth', $iyzico)->assertOk()->assertJsonPath('status', 'success');

        $lidio = ['paymentInstrument'=>'NewCard','amount'=>10,'paymentInstrumentInfo'=>['newCard'=>['cardNumber'=>'5528790000000008','cvv'=>'123']]];
        $this->postJson('/providers/lidio/Payment/ProcessPayment', $lidio)->assertOk()->assertJsonPath('result', 'Success');

        $xml = '<GVPSRequest><Card><Number>4282209004348015</Number></Card><Order><OrderID>order-1</OrderID></Order><Transaction><Type>sales</Type><Amount>1000</Amount></Transaction></GVPSRequest>';
        $this->call('POST', '/providers/garanti/VPServlet', [], [], [], ['CONTENT_TYPE'=>'application/xml'], $xml)->assertOk()->assertSee('<Code>00</Code>', false);
    }
}
