import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
const source = readFileSync(new URL("../contracts/StatisticsAnchor.sol", import.meta.url), "utf8");
const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "StatisticsAnchor.sol": { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.methodIdentifiers"] } } } })));
const errors = (output.errors ?? []).filter(e => e.severity === "error");
if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join("\n"));
const contract = output.contracts["StatisticsAnchor.sol"].StatisticsAnchor;
if (process.argv.includes("--write")) {
  mkdirSync(new URL("../contracts/build/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../contracts/build/StatisticsAnchor.json", import.meta.url), JSON.stringify({ compiler: solc.version(), sourceHash: createHash("sha256").update(source).digest("hex"), ...contract }, null, 2) + "\n");
}
console.log(`StatisticsAnchor compiled (${contract.evm.bytecode.object.length / 2} bytes); no transaction sent.`);
