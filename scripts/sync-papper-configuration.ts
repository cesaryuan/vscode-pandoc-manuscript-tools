/**
 * Regenerates the extension's offline configuration contract and readable YAML example.
 * Run `npm run sync:papper-config -- <papper-executable>` after building Papper;
 * omitting the executable uses `papper` on PATH. The script validates the complete
 * versioned JSON before writing either asset, and never edits manuscript projects.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { parseConfigurationContract } from "../src/configurationContract";

const executable = process.argv[2] ?? "papper";
const output = execFileSync(executable, ["config", "describe", "--format", "json"], {
  encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, PAPPER_DISABLE_UPDATE_CHECK: "1" },
});
const contract = parseConfigurationContract(JSON.parse(output));
const assets = path.resolve(__dirname, "../assets");
writeFileSync(path.join(assets, "papper-configuration.json"), JSON.stringify(contract, null, 2) + "\n");
writeFileSync(path.join(assets, "style-project.yml"), contract.templates.styleProject);
console.log(`Synced configuration contract v${contract.contractVersion} from Papper ${contract.papperVersion}`);
