import test from 'node:test';import assert from 'node:assert/strict';
import {PhoneAuth} from './phone-auth.mjs';
import {phoneOrigin} from './phone-origin.mjs';
test('pairing uses the configured HTTPS origin and preserves an explicit port',()=>{
  assert.equal(phoneOrigin('https://phone.example.test:8443/'),'https://phone.example.test:8443');
  for(const input of ['', 'http://phone.example.test', 'https://phone.example.test/app', 'https://phone.example.test/?q=test', 'https://user@phone.example.test']){
    assert.throws(()=>phoneOrigin(input), /ASTERHELM_PUBLIC_ORIGIN/);
  }
});
test('single use pairing, expiry, revocation and persistent sessions',()=>{
  const auth=new PhoneAuth(':memory:');
  const invite=auth.invite(5000);
  const session=auth.redeem(invite,5001);
  assert.ok(auth.valid(session,5002)); assert.equal(auth.redeem(invite,5002),null);
  assert.equal(auth.valid('unknown',5002),false);
  auth.logout(session);assert.equal(auth.valid(session,5002),false);
  const expired=auth.invite(1000);assert.equal(auth.redeem(expired,1000+16*60000),null);
});
