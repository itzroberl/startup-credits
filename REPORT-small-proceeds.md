# Medium: sell-spread rung permanently accounts for undistributed sBTC

Target: `Rapha-btc/jing-contracts-v3` at `6bf0470f6cb7c0441b201a7a4e9d11e5408ca515`, specifically `contracts/jing-sell-stx-market-spread.clar`. This is a distinct accounting path from the already reported index-floor epoch close and the v6-3 pegged-order admission gate. No production deployment or real funds were used in this test.

## Impact

After ordinary sell-down and top-up cycles, the rung can have more than `gained * SCALE` shares while its `unfilled-index` is still above the closing floor. A valid, minimum-size market swap then sends sBTC to the rung, but `sync` rounds the per-share proceeds increment to zero and nevertheless marks the full sBTC balance as accounted. `get-position` and `claim` show/pay zero for the new proceeds. A later `sync` sees no new gain, so the discarded credit does not reappear. Repeated small fills can strand further proceeds. The demonstrated fill strands 1,001 sats (the whole net maker receipt) without closing the epoch.

## Root cause

[`jing-sell-stx-market-spread.clar:226-269`](https://github.com/Rapha-btc/jing-contracts-v3/blob/6bf0470f6cb7c0441b201a7a4e9d11e5408ca515/contracts/jing-sell-stx-market-spread.clar#L226-L269) computes:

```clarity
(new-proceeds (if (> gained u0)
  (+ (var-get proceeds-index) (/ (* gained SCALE) shares))
  (var-get proceeds-index)))
...
(var-set sats-accounted sbtc-now)
```

At the demonstrated state, `shares = 1,704,900,935,893,411`, `SCALE = 1,000,000,000,000`, and `gained = 1,001 sats`. Therefore `floor(gained * SCALE / shares) = 0`. Advancing `sats-accounted` from 1 to 1,002 erases this gain from all future `sync` calculations even though no index credit was created. The parallel buy-spread rung uses the same index/accounted pattern for STX at lines 259-289; I did not separately reproduce that side.

## Reproduction on a mainnet fork

[Executed Stxer simulation](https://stxer.xyz/simulations/mainnet/e4f952f36fd5bd28262754c12cdfc847) at block 9,070,046. The [reproduction script](simulations/verify-v6-3-proceeds-real-market.js) deploys the unmodified ladder-v1, market v6-3, and sell-spread rung contract sources under their normal names. It initializes the market with the repository's 1,000-sat sBTC / 1-STX minimums, verifies the market in the live core, registers the rung, obtains a fresh signed Lazer update, and performs real `swap` calls against the fresh v6-3 market. The sBTC/STX balances and transfers are simulated on the fork; there is no mainnet spending.

1. Deposit 100 STX into the sell-spread rung. Swap most of it for sBTC; `sync` leaves 11,683 micro-STX, epoch 0, `unfilled-index = 116,830,000`.
2. Deposit another 100 STX. Swap about 99.008 STX. `sync` leaves 1,004,720 micro-STX, epoch 0, `unfilled-index = 1,173,678`, still above `SOLD_OUT_INDEX = 1,000,000`.
3. Deposit 2,000 STX. `total-shares = 1,704,900,935,893,411`; `proceeds-index = 400,866,363`. The rung already holds one sat of ordinary rounding residue.
4. Call market `swap` with 1,002 sats. Its 2-sat taker rebate leaves the 1,000-sat market minimum; after the 1-sat maker fee, the rung receives 1,001 sats. `swap` and `sync` both return `ok`.
5. The sBTC balance moves from 1 to 1,002 sats and `sats-accounted` becomes 1,002. `proceeds-index` stays **400,866,363**, epoch stays **0**, `get-position` reports `(sbtc u0)`, and `claim` returns `(sbtc u0)` without reducing the 1,002-sat balance.

To rerun, check out the target commit, run `npm ci`, copy the linked script into its `simulations/` directory next to `_lazer.js`, and run `node --dns-result-order=ipv4first simulations/verify-v6-3-proceeds-real-market.js`. The script asserts the share threshold, unchanged index, new sBTC balance, accounted balance, zero entitlement, and post-claim balance. It fetches a fresh public Lazer update; because oracle prices/rebates vary, numerical balances can differ between runs, while the assertions test the invariant.

## Fix direction

Do not advance the accounted watermark for a gain that was not represented in claimable member credit. Track unindexed proceeds as an explicit per-epoch carry (including the division remainder), and allocate or settle that carry to the holders at the time it arose before membership/epoch changes; alternatively change the share/reward accounting so every valid fill is exactly attributable. Advancing `sats-accounted` to the entire balance is safe only after proving the gain has become claimable. A regression should replay the sequence above, assert that the 1,001 new sats are eventually allocated or explicitly refundable, and cover a deposit/withdraw and an epoch transition while carry exists.

