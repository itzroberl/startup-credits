// Mainnet-fork regression for small sBTC proceeds after share inflation.
// Deploys the unmodified ladder, market and sell-spread rung sources.
import fs from "node:fs";
import {
  ClarityVersion, uintCV, bufferCV, stringAsciiCV, contractPrincipalCV, trueCV,
  deserializeCV, cvToString,
} from "@stacks/transactions";
import { SimulationBuilder, getSimulationResult } from "stxer";
import { fetchLazerUpdateAny } from "./_lazer.js";

const DEP = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const MEMBER = "SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51";
const TAKER = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";
const CORE = `${DEP}.jing-core-v5`;
const LADDER = "jing-ladder-v1";
const MARKET = "markets-sbtc-stx-jing-v6-3";
const RUNG = "jing-sell-stx-spread-20-cap-1-00";
const MID = `${DEP}.${MARKET}`;
const RID = `${DEP}.${RUNG}`;
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const sbtcT = contractPrincipalCV("SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", "sbtc-token");
const wstxT = contractPrincipalCV("SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR", "token-stx-v-1-2");
const sbtcA = stringAsciiCV("sbtc-token");
const wstxA = stringAsciiCV("wstx");
const src = (name) => fs.readFileSync(new URL(`../contracts/${name}.clar`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const lz = await fetchLazerUpdateAny();
const UPDATE = bufferCV(Buffer.from(lz.hex, "hex"));
const mid = (lz.px * 100_000_000n) / lz.py;
const bid = (mid * 9980n) / 10000n;
const tradedY = (sats) => ((sats - (sats * 20n) / 10000n) * bid) / 10_000_000_000n;
function xForY(ustx) {
  let sats = (ustx * 10_000_000_000n * 10000n) / (bid * 9980n);
  while (tradedY(sats) > ustx) sats -= 1n;
  while (tradedY(sats + 1n) <= ustx) sats += 1n;
  return sats;
}
const noUpdate = bufferCV(Buffer.from("00", "hex"));

let builder = SimulationBuilder.new({ stacksNodeAPI: "http://77.42.3.101/stacks-api" });
const steps = [];
function deploy(name, file = name) {
  builder.withSender(DEP).addContractDeploy({
    contract_name: name, source_code: src(file), clarity_version: ClarityVersion.Clarity5,
  });
  steps.push({ label: `deploy ${name}`, kind: "tx" });
}
function call(label, sender, contract, fn, args) {
  builder.withSender(sender).addContractCall({
    contract_id: contract, function_name: fn, function_args: args,
  });
  steps.push({ label, kind: "tx" });
}
function evalCode(label, code) {
  builder.addEvalCode(RID, code);
  steps.push({ label, kind: "eval" });
}
function decode(step, kind) {
  const result = kind === "tx" ? step?.Result?.Transaction : step?.Result?.Eval;
  if (!result || result.Err || result.Ok?.vm_error) throw new Error(JSON.stringify(result));
  return cvToString(deserializeCV(kind === "tx" ? result.Ok.result : result.Ok));
}
function swap(label, amount) {
  call(label, TAKER, MID, "swap", [uintCV(amount), uintCV((mid * 9970n) / 10000n),
    UPDATE, sbtcT, sbtcA, wstxT, wstxA, trueCV()]);
}

deploy(LADDER);
deploy(MARKET);
deploy(RUNG, "jing-sell-stx-market-spread");
call("sync seats", DEP, MID, "sync-seat-count", []);
call("verify market", DEP, CORE, "set-verified-contract", [contractPrincipalCV(DEP, MARKET)]);
call("initialize market", DEP, MID, "initialize", [contractPrincipalCV(DEP, MARKET), sbtcT,
  wstxT, uintCV(1000), uintCV(1_000_000), uintCV(1), uintCV(45)]);
call("set canonical rung", DEP, `${DEP}.${LADDER}`, "set-canonical",
  [stringAsciiCV("sell-peg"), contractPrincipalCV(DEP, RUNG)]);
call("initialize rung", DEP, RID, "initialize", [uintCV(20), uintCV(100)]);
call("initial deposit 100 STX", MEMBER, RID, "deposit", [uintCV(100_000_000), noUpdate]);
swap("first sell-down to about 0.01 STX", xForY(99_990_000n));
call("sync first fill", TAKER, RID, "sync", []);
evalCode("after first fill", "(get-state)");
call("deposit another 100 STX", MEMBER, RID, "deposit", [uintCV(100_000_000), UPDATE]);
swap("second sell-down to about 1.002 STX", xForY(99_008_000n));
call("sync second fill", TAKER, RID, "sync", []);
evalCode("after second fill", "(get-state)");
call("large top-up 2000 STX", MEMBER, RID, "deposit", [uintCV(2_000_000_000), UPDATE]);
evalCode("before target fill", "(get-state)");
evalCode("balance before target fill", `(contract-call? '${SBTC} get-balance '${RID})`);
swap("minimum-size 1002-sat taker swap", 1002n);
call("sync target fill", TAKER, RID, "sync", []);
evalCode("after target fill", "(get-state)");
evalCode("balance after target fill", `(contract-call? '${SBTC} get-balance '${RID})`);
evalCode("accounted sats after target fill", "(var-get sats-accounted)");
evalCode("member entitlement", `(get-position '${MEMBER})`);
call("member claim", MEMBER, RID, "claim", []);
evalCode("balance after claim", `(contract-call? '${SBTC} get-balance '${RID})`);

if (process.argv[2]) {
  const limit = Number(process.argv[2]);
  builder.steps = builder.steps.slice(0, limit);
  steps.length = limit;
}
const simulationId = await builder.run();
console.log(`simulation: https://stxer.xyz/simulations/mainnet/${simulationId}`);
const result = await getSimulationResult(simulationId);
let index = 0;
for (const item of steps) {
  while (index < result.steps.length &&
    !result.steps[index]?.Result?.Transaction && !result.steps[index]?.Result?.Eval) index += 1;
  const value = decode(result.steps[index], item.kind);
  if (item.kind === "tx" && !value.startsWith("(ok ")) throw new Error(`${item.label}: ${value}`);
  console.log(`${item.label}: ${value}`);
  item.value = value;
  index += 1;
}
if (process.argv[2]) process.exit(0);
const valueOf = (label) => steps.find((step) => step.label === label)?.value;
const field = (label, name) => BigInt(valueOf(label).match(new RegExp(`\\(${name} u(\\d+)\\)`))?.[1] ?? -1);
const balance = (label) => BigInt(valueOf(label).match(/\(ok u(\d+)\)/)?.[1] ?? -1);
const uint = (label) => BigInt(valueOf(label).match(/^u(\d+)$/)?.[1] ?? -1);
if (field("before target fill", "total-shares") <= 1_000_000_000_000_000n ||
    field("before target fill", "proceeds-index") !== field("after target fill", "proceeds-index") ||
    balance("balance after target fill") - balance("balance before target fill") < 990n ||
    uint("accounted sats after target fill") !== balance("balance after target fill") ||
    !valueOf("member entitlement").includes("(sbtc u0)") ||
    !valueOf("member claim").includes("(sbtc u0)") ||
    balance("balance after target fill") !== balance("balance after claim")) {
  throw new Error("Small proceeds did not stay stranded on the real market path");
}

