#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "..");
const finalRulesPath = path.join(repositoryRoot, "firebase/database.rules.json");
const maintenanceRulesPath = path.join(
  repositoryRoot,
  "firebase/database.rules.maintenance.json"
);

function freezeWrites(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  Object.keys(node).forEach((key) => {
    if (key === ".write") {
      node[key] = false;
      return;
    }
    freezeWrites(node[key]);
  });
}

function buildMaintenanceRules(finalRules) {
  const maintenance = JSON.parse(JSON.stringify(finalRules));
  freezeWrites(maintenance);
  return maintenance;
}

function main() {
  const finalRules = JSON.parse(fs.readFileSync(finalRulesPath, "utf8"));
  const maintenance = buildMaintenanceRules(finalRules);
  fs.writeFileSync(
    maintenanceRulesPath,
    `${JSON.stringify(maintenance, null, 2)}\n`
  );
  process.stdout.write(`${path.relative(repositoryRoot, maintenanceRulesPath)}\n`);
}

if (require.main === module) main();

module.exports = { buildMaintenanceRules };
