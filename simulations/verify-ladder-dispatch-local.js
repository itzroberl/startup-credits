// Deterministic helper tests. Tiny seated-rung fixtures use STX on both sides
// to isolate routing/atomicity; the mainnet-fork suite tests real sBTC/STX rungs.
// Run: node simulations/verify-ladder-dispatch-local.js
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { getSDK } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const sim = await getSDK();
await sim.initEmptySession(null);
sim.setEpoch('3.4');
const DEP = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM';
const USER = 'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5';
const OTHER = DEP;
sim.mintSTX(USER, 1_000_000_000n);
let checks = 0;
function check(label, actual, expected) {
  assert.equal(actual, expected, label); checks++;
}
function deploy(name, source) {
  check(`deploy ${name}`, cvToString(sim.deployContract(name, source, { clarityVersion: 5 }, DEP).result), 'true');
}
const cp = n => Cl.contractPrincipal(DEP, n);
const call = (contract, fn, args, sender = USER) => sim.callPublicFn(`${DEP}.${contract}`, fn, args, sender);
const string = r => cvToString(r.result);
const read = (contract, fn, args = []) => string(sim.callReadOnlyFn(`${DEP}.${contract}`, fn, args, USER));
const balance = who => cvToString(sim.execute(`(stx-get-balance '${who})`).result);
deploy('jing-ladder-v1', `
  (define-map seats principal uint)
  (define-map registered principal (string-ascii 8))
  (define-public (set-seat (who principal) (side uint))
    (begin
      (if (> side u0)
        (map-set registered who (if (is-eq side u1) "buy-band" "sel-band"))
        false)
      (ok (map-set seats who side))))
  (define-read-only (get-registered (who principal))
    (match (map-get? registered who)
      side (some { side: side, price: u0 }) none))
  (define-read-only (is-band-x (who principal)) (is-eq (default-to u0 (map-get? seats who)) u1))
  (define-read-only (is-band-y (who principal)) (is-eq (default-to u0 (map-get? seats who)) u2))
`);
deploy('jing-rung-deposit-trait', fs.readFileSync('contracts/jing-rung-deposit-trait.clar', 'utf8').replaceAll('\r\n', '\n'));
deploy('jing-ladder-dispatch', fs.readFileSync('contracts/jing-ladder-dispatch.clar', 'utf8').replaceAll('\r\n', '\n').replaceAll('SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22', DEP));
const fixture = `
  (define-map credits principal uint)
  (define-read-only (credit (who principal)) (default-to u0 (map-get? credits who)))
  (define-public (deposit (amount uint) (update (buff 8192)))
    (begin
      (asserts! (not (is-eq amount u13)) (err u999))
      (try! (stx-transfer? amount tx-sender current-contract))
      (map-set credits tx-sender (+ amount (credit tx-sender)))
      (asserts! (not (is-eq amount u17)) (err u997))
      (ok { amount: amount, shares: amount, epoch: u0, stx-paid: u0, sbtc-paid: u0 })
    ))
  (define-public (withdraw (amount uint))
    (let ((member tx-sender) (have (credit tx-sender)))
      (asserts! (> have u0) (err u998))
      (asserts! (not (is-eq amount u13)) (err u999))
      (let ((take (if (> amount have) have amount)))
        (map-set credits tx-sender (- have take))
        (try! (as-contract? ((with-stx take))
          (try! (stx-transfer? take current-contract member))
        ))
        (asserts! (not (is-eq amount u17)) (err u997))
        (ok { stx: take, sbtc: u0 }))))
  (define-public (claim) (ok { stx: u0, sbtc: u0 }))
`;
for (let i = 0; i < 10; i++) {
  deploy(`rung-${i}`, fixture);
  check('seat fixture', string(call('jing-ladder-v1', 'set-seat', [cp(`rung-${i}`), Cl.uint(2)])), '(ok true)');
}
const entries = list => Cl.list(list.map(([i, amount]) => Cl.tuple({ rung: cp(`rung-${i}`), amount: Cl.uint(amount) })));
const dispatch = (total, rows, side = 'sell') => call('jing-ladder-dispatch', `deposit-${side}`, [Cl.uint(total), entries(rows), Cl.bufferFromHex('')]);
const withdraw = (rows, side = 'sell') => call('jing-ladder-dispatch', `withdraw-${side}`, [entries(rows)]);
const credit = i => read(`rung-${i}`, 'credit', [Cl.standardPrincipal(USER)]);
// Exact response checks, including every per-rung result and the aggregate.
const sortedTuple = fields => Cl.tuple(Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))));
const expectedDeposit = (total, rows) => cvToString(Cl.ok(sortedTuple({
  amount: Cl.uint(total), rungs: Cl.uint(rows.length),
  'stx-paid': Cl.uint(0), 'sbtc-paid': Cl.uint(0),
  positions: Cl.list(rows.map(([i, amount]) => sortedTuple({
    rung: cp(`rung-${i}`), amount: Cl.uint(amount), shares: Cl.uint(amount),
    epoch: Cl.uint(0),
    'stx-paid': Cl.uint(0), 'sbtc-paid': Cl.uint(0),
  }))),
})));
const expectedExit = rows => cvToString(Cl.ok(sortedTuple({
  rungs: Cl.uint(rows.length), withdrawn: Cl.uint(rows.length), sbtc: Cl.uint(0),
  stx: Cl.uint(rows.reduce((sum, [, take]) => sum + take, 0)),
  positions: Cl.list(rows.map(([i, take]) => sortedTuple({
    rung: cp(`rung-${i}`), stx: Cl.uint(take), sbtc: Cl.uint(0),
  }))),
})));
const rows = Array.from({ length: 10 }, (_, i) => [i, (i + 1) * 100]);
check('weighted ten-rung dispatch with exact receipt', string(dispatch(5500, rows)), expectedDeposit(5500, rows));
for (let i = 0; i < 10; i++) {
  check(`user owns rung ${i}`, credit(i), `u${(i + 1) * 100}`);
  check(`helper owns no shares ${i}`, read(`rung-${i}`, 'credit', [cp('jing-ladder-dispatch')]), 'u0');
  check(`other user owns no shares ${i}`, read(`rung-${i}`, 'credit', [Cl.standardPrincipal(OTHER)]), 'u0');
}
const invalid = [
  ['empty', 1, [], 'sell', 7101],
  ['zero total', 0, [[0, 1]], 'sell', 7102],
  ['sum too high', 99, [[0, 100]], 'sell', 7102],
  ['sum too low', 101, [[0, 100]], 'sell', 7102],
  ['zero leg', 100, [[0, 0], [1, 100]], 'sell', 7103],
  ['duplicate', 200, [[0, 100], [0, 100]], 'sell', 7105],
  ['wrong side', 100, [[0, 100]], 'buy', 7104],
  ['second leg errors', 113, [[0, 100], [1, 13]], 'sell', 999],
  ['second leg errors after transfer', 117, [[0, 100], [1, 17]], 'sell', 997],
  ['uint budget overflow prevented', (1n << 128n) - 1n, [[0, (1n << 128n) - 1n], [1, 1]], 'sell', 7102],
];
for (const [label, total, list, side, error] of invalid) {
  const before = balance(USER), c0 = credit(0), c1 = credit(1);
  check(label, string(dispatch(total, list, side)), `(err u${error})`);
  check(`${label}: wallet unchanged`, balance(USER), before);
  check(`${label}: first rung unchanged`, credit(0), c0);
  check(`${label}: second rung unchanged`, credit(1), c1);
}
call('jing-ladder-v1', 'set-seat', [cp('rung-0'), Cl.uint(0)]);
check('retired rung rejected', string(dispatch(100, [[0, 100]])), '(err u7104)');
call('jing-ladder-v1', 'set-seat', [cp('rung-0'), Cl.uint(1)]);
check('current buy seat accepted', string(dispatch(100, [[0, 100]], 'buy')), expectedDeposit(100, [[0, 100]]));
check('same seat rejected on sell side', string(dispatch(100, [[0, 100]], 'sell')), '(err u7104)');
const withdrawBalance = BigInt(balance(USER).slice(1));
check('rung 1 holds deposited STX', balance(`${DEP}.rung-1`), 'u200');
check('rung 2 holds deposited STX', balance(`${DEP}.rung-2`), 'u300');
check('rung 3 holds deposited STX', balance(`${DEP}.rung-3`), 'u400');
check('one call withdraws three sell rungs', string(withdraw([[1, 50], [2, 999999], [3, 100]])),
  expectedExit([[1, 50], [2, 300], [3, 100]]));
check('partial withdraw credited', credit(1), 'u150');
check('oversized request capped to full position', credit(2), 'u0');
check('third rung partially withdrawn', credit(3), 'u300');
check('three-rung proceeds paid directly to user', balance(USER), `u${withdrawBalance + 450n}`);
call('jing-ladder-v1', 'set-seat', [cp('rung-4'), Cl.uint(0)]);
check('retired but registered rung remains withdrawable', string(withdraw([[4, 999999]])),
  expectedExit([[4, 500]]));
check('retired rung fully exited', credit(4), 'u0');
check('withdraw rejects wrong registered side', string(withdraw([[0, 1]], 'sell')), '(err u7108)');
check('withdraw rejects zero amount', string(withdraw([[1, 0]])), '(err u7103)');
check('withdraw rejects duplicate rung', string(withdraw([[1, 1], [1, 1]])), '(err u7105)');
const exitBefore = balance(USER), exitCredit1 = credit(1), exitCredit5 = credit(5);
check('later withdraw error rolls entire batch back', string(withdraw([[1, 10], [5, 13]])), '(err u999)');
check('failed batch restores wallet', balance(USER), exitBefore);
check('failed batch restores first rung', credit(1), exitCredit1);
check('failed batch preserves failing rung', credit(5), exitCredit5);
check('post-transfer error rolls entire batch back', string(withdraw([[1, 10], [5, 17]])), '(err u997)');
check('post-transfer error batch restores wallet', balance(USER), exitBefore);
check('post-transfer error batch restores first rung', credit(1), exitCredit1);
check('post-transfer error batch restores second rung', credit(5), exitCredit5);
deploy('forwarder', `
  (use-trait rung .jing-rung-deposit-trait.rung-trait)
  (define-public (forward (target <rung>))
    (contract-call? .jing-ladder-dispatch deposit-buy u100
      (list { rung: target, amount: u100 }) 0x))
`);
const before = balance(USER);
check('indirect caller cannot spend user funds', string(call('forwarder', 'forward', [cp('rung-0')])), '(err u7106)');
check('indirect call preserves balance', balance(USER), before);
check('helper holds no STX', balance(`${DEP}.jing-ladder-dispatch`), 'u0');
console.log(`${checks}/${checks} local helper checks passed`);

