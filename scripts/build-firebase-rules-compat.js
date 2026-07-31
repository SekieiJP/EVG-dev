#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "..");
const finalRulesPath = path.join(repositoryRoot, "firebase/database.rules.json");
const compatRulesPath = path.join(repositoryRoot, "firebase/database.rules.compat-v4.json");
const HOST = "auth != null && root.child('rooms').child($roomId).child('roles').child('hosts').child(auth.uid).val() === true";

function buildCompatRules(finalRules) {
  const compat = JSON.parse(JSON.stringify(finalRules));
  const room = compat.rules.rooms.$roomId;

  // The first deployment only adds v4 public projections. Legacy r11 clients
  // keep their existing private reads until the v4 backfill and web release
  // have both completed. The final Rules file then closes these parents.
  room.config[".read"] = "auth != null";
  room.players[".read"] = "auth != null";
  room.players[".write"] = HOST;
  room.ticketPresence.$stageId[".read"] = "auth != null";
  room.results.$stageId[".read"] = "auth != null";
  room.scores[".read"] = "auth != null";
  room.scores[".write"] = HOST;

  return compat;
}

function main() {
  const finalRules = JSON.parse(fs.readFileSync(finalRulesPath, "utf8"));
  const compat = buildCompatRules(finalRules);
  fs.writeFileSync(compatRulesPath, `${JSON.stringify(compat, null, 2)}\n`);
  process.stdout.write(`${path.relative(repositoryRoot, compatRulesPath)}\n`);
}

if (require.main === module) main();

module.exports = { buildCompatRules };
