const assert = require("assert");
const fs = require("fs");
const { buildCompatRules } = require("../scripts/build-firebase-rules-compat");
const { buildCompatRules: buildMembershipCompatRules } = require("../scripts/build-firebase-rules-compat-v5");

const finalRulesDocument = JSON.parse(fs.readFileSync("firebase/database.rules.json", "utf8"));
const rules = finalRulesDocument.rules;
const roomRules = rules.rooms.$roomId;
const rulesText = JSON.stringify(rules);

function changedLeafPaths(left, right, prefix = "") {
  const keys = new Set(Object.keys(left || {}).concat(Object.keys(right || {})));
  return Array.from(keys).flatMap((key) => {
    const path = prefix ? `${prefix}/${key}` : key;
    const leftValue = left && left[key];
    const rightValue = right && right[key];
    if (
      leftValue && rightValue &&
      typeof leftValue === "object" && typeof rightValue === "object" &&
      !Array.isArray(leftValue) && !Array.isArray(rightValue)
    ) {
      return changedLeafPaths(leftValue, rightValue, path);
    }
    return JSON.stringify(leftValue) === JSON.stringify(rightValue) ? [] : [path];
  });
}

function run(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`not ok ${name}`);
    throw error;
  }
}

run("room root read and write are closed", () => {
  assert.strictEqual(roomRules[".read"], false);
  assert.strictEqual(roomRules[".write"], false);
});

run("host authority uses roles allowlist", () => {
  assert.ok(roomRules.roles.hosts.$uid);
  assert.strictEqual(roomRules.roles.hosts.$uid[".write"], false);
  assert.match(roomRules.public[".write"], /roles'\)\.child\('hosts/);
  assert.doesNotMatch(rulesText, /meta'\)\.child\('hostUid|meta\.hostUid/);
});

run("snapshot node is not readable or writable", () => {
  assert.strictEqual(roomRules.snapshot[".read"], false);
  assert.strictEqual(roomRules.snapshot[".write"], false);
});

run("public writes require version increment and allowed phases", () => {
  const validation = roomRules.public[".validate"];
  assert.match(validation, /roomVersion/);
  assert.match(validation, /\(!data\.exists\(\) \|\| newData\.child\('roomVersion'\)\.val\(\) === data\.child\('roomVersion'\)\.val\(\) \+ 1\)/);
  assert.doesNotMatch(validation, /gameId'\)\.val\(\) !== data\.child\('gameId'\)\.val\(\) \|\| newData\.child\('roomVersion/);
  assert.match(roomRules.public.phase[".validate"], /lobby\|stage_intro\|voting\|countdown\|tallying\|reveal\|ranking\|final/);
  assert.strictEqual(roomRules.public.$other[".validate"], false);
  assert.deepStrictEqual(
    Object.keys(roomRules.public).filter((key) => !key.startsWith(".")).sort(),
    [
      "$other",
      "abstainedCount",
      "activeGenerationId",
      "animationSkippedAt",
      "animationStartedAt",
      "countdownEndsAt",
      "currentStageId",
      "currentStageIndex",
      "gameId",
      "phase",
      "playerCount",
      "revealEndsAt",
      "roomVersion",
      "submittedCount",
      "tallyingEndsAt",
    ].sort()
  );
  ["roomVersion", "currentStageIndex", "playerCount", "submittedCount", "abstainedCount"].forEach((key) => {
    assert.match(roomRules.public[key][".validate"], /newData\.isNumber/);
  });
});

run("stage results allow create or delete but never overwrite", () => {
  assert.match(roomRules.results[".read"], /roles'\)\.child\('hosts/);
  assert.strictEqual(roomRules.results[".write"], false);
  assert.match(roomRules.results.$stageId[".write"], /!data\.exists\(\) \|\| newData\.val\(\) === null/);
});

run("private live-game parents are Host-only and Player reads stop at self children", () => {
  ["config", "players", "results", "scores"].forEach((key) => {
    assert.match(roomRules[key][".read"], /roles'\)\.child\('hosts/);
  });
  assert.strictEqual(roomRules.ticketPresence[".read"], false);
  assert.match(roomRules.ticketPresence.$stageId[".read"], /roles'\)\.child\('hosts/);
  assert.strictEqual(roomRules.players[".write"], false);
  assert.strictEqual(roomRules.scores[".write"], false);
  assert.match(roomRules.players.$uid[".read"], /auth\.uid === \$uid/);
  assert.match(roomRules.ticketPresence.$stageId.$uid[".read"], /auth\.uid === \$uid/);
  assert.match(roomRules.results.$stageId.players.$uid[".read"], /auth\.uid === \$uid/);
  assert.match(roomRules.scores.$uid[".read"], /auth\.uid === \$uid/);
});

run("public projections are authenticated, allowlisted, and keep owner mapping private", () => {
  ["publicConfig", "publicPlayers", "publicTicketPresence", "publicResults", "publicScores"].forEach((key) => {
    assert.strictEqual(roomRules[key][".read"], "auth != null");
  });
  assert.match(roomRules.publicProfileOwners[".read"], /roles'\)\.child\('hosts/);
  assert.strictEqual(roomRules.publicProfileOwners[".write"], false);
  assert.match(roomRules.publicProfileOwners.$profileId[".write"], /newData\.parent\(\)\.parent\(\)\.child\('players'/);
  assert.match(roomRules.publicPlayers.$profileId[".write"], /publicProfileOwners/);
  assert.match(roomRules.publicTicketPresence.$stageId.$profileId[".write"], /publicProfileOwners/);
  assert.strictEqual(roomRules.publicPlayers.$profileId.$other[".validate"], false);
  assert.strictEqual(roomRules.publicTicketPresence.$stageId.$profileId.$other[".validate"], false);
  assert.strictEqual(roomRules.publicResults.$stageId.$other[".validate"], false);
  assert.strictEqual(roomRules.publicScores.$profileId.$other[".validate"], false);
  assert.strictEqual(roomRules.publicConfig.$other[".validate"], false);
  assert.doesNotMatch(JSON.stringify(roomRules.publicResults), /uuid|ticket|prediction|stageSkill/i);
});

run("compatibility Rules are generated from final Rules and reopen only legacy reads", () => {
  const generated = buildCompatRules(finalRulesDocument);
  const checkedIn = JSON.parse(fs.readFileSync("firebase/database.rules.compat-v4.json", "utf8"));
  assert.deepStrictEqual(checkedIn, generated);
  assert.deepStrictEqual(changedLeafPaths(finalRulesDocument, generated).sort(), [
    "rules/rooms/$roomId/config/.read",
    "rules/rooms/$roomId/players/.read",
    "rules/rooms/$roomId/players/.write",
    "rules/rooms/$roomId/results/$stageId/.read",
    "rules/rooms/$roomId/scores/.read",
    "rules/rooms/$roomId/scores/.write",
    "rules/rooms/$roomId/ticketPresence/$stageId/.read",
  ]);
});

run("membership compatibility Rules allow legacy shapes only before the v5 marker", () => {
  const generated = buildMembershipCompatRules(finalRulesDocument);
  const checkedIn = JSON.parse(fs.readFileSync("firebase/database.rules.compat-v5.json", "utf8"));
  assert.deepStrictEqual(checkedIn, generated);
  assert.deepStrictEqual(changedLeafPaths(finalRulesDocument, generated).sort(), [
    "rules/rooms/$roomId/meta/.validate",
    "rules/rooms/$roomId/playerStats/$uid/.write",
    "rules/rooms/$roomId/playerStats/.write",
    "rules/rooms/$roomId/players/$uid/.validate",
    "rules/rooms/$roomId/players/$uid/.write",
    "rules/rooms/$roomId/players/$uid/name/.validate",
    "rules/rooms/$roomId/players/$uid/pendingName/.validate",
    "rules/rooms/$roomId/public/.validate",
    "rules/rooms/$roomId/publicPlayers/$profileId/.validate",
    "rules/rooms/$roomId/publicPlayers/$profileId/.write",
    "rules/rooms/$roomId/publicProfileOwners/$profileId/.write",
    "rules/rooms/$roomId/publicScores/$profileId/.validate",
    "rules/rooms/$roomId/publicScores/$profileId/.write",
    "rules/rooms/$roomId/publicTicketPresence/$stageId/$profileId/.validate",
    "rules/rooms/$roomId/publicTicketPresence/$stageId/$profileId/.write",
    "rules/rooms/$roomId/publicTicketPresence/$stageId/.write",
    "rules/rooms/$roomId/scores/$uid/.validate",
    "rules/rooms/$roomId/scores/$uid/.write",
    "rules/rooms/$roomId/ticketPresence/$stageId/$uid/.validate",
    "rules/rooms/$roomId/ticketPresence/$stageId/$uid/.write",
    "rules/rooms/$roomId/ticketPresence/$stageId/.write",
    "rules/rooms/$roomId/tickets/$stageId/$uid/.validate",
    "rules/rooms/$roomId/tickets/$stageId/$uid/.write",
    "rules/rooms/$roomId/tickets/$stageId/.write",
  ].sort());
  changedLeafPaths(finalRulesDocument, generated).forEach((path) => {
    const segments = path.split("/");
    let value = generated;
    segments.forEach((segment) => { value = value[segment]; });
    assert.match(String(value), /membershipSchemaVersion/);
  });
  ["config", "players", "results", "scores"].forEach((key) => {
    assert.strictEqual(generated.rules.rooms.$roomId[key][".read"], roomRules[key][".read"]);
  });
  assert.strictEqual(
    generated.rules.rooms.$roomId.ticketPresence.$stageId[".read"],
    roomRules.ticketPresence.$stageId[".read"]
  );
});

run("membership generations, per-player CAS and exact name claims are enforced", () => {
  assert.match(roomRules.meta[".validate"], /membershipSchemaVersion/);
  assert.match(roomRules.membership[".write"], /roles'\)\.child\('hosts/);
  assert.match(roomRules.membership[".validate"], /public'\)\.child\('activeGenerationId/);
  assert.match(roomRules.public[".validate"], /membership'\)\.child\('activeGenerationId/);
  assert.match(roomRules.public[".validate"], /gameId/);

  const privatePlayer = roomRules.players.$uid;
  assert.match(privatePlayer[".write"], /newData\.exists\(\)/);
  assert.match(privatePlayer[".validate"], /profileRevision/);
  assert.match(privatePlayer[".validate"], /nameClaims/);
  assert.match(privatePlayer[".validate"], /publicPlayers/);
  assert.match(privatePlayer[".validate"], /publicScores/);
  assert.ok(privatePlayer[".validate"].includes(
    "!data.child('profileRevision').exists() && newData.child('profileRevision').val() === 1"
  ));
  assert.doesNotMatch(privatePlayer.name[".validate"], /!data\.parent\(\)\.child\('pendingName'\)\.exists/);
  assert.match(privatePlayer.name[".validate"], /data\.parent\(\)\.child\('pendingName'\)\.exists/);
  assert.match(privatePlayer.name[".validate"], /\\x00/);
  assert.match(privatePlayer.pendingName[".validate"], /\\x00/);

  const claim = roomRules.nameClaims.$generationId.$normalizedName;
  assert.match(roomRules.nameClaims[".read"], /roles'\)\.child\('hosts/);
  assert.match(claim[".read"], /ownerUid/);
  assert.match(claim[".write"], /!newData\.exists\(\)/);
  assert.match(claim[".write"], /nameClaimKey/);
  assert.match(claim[".write"], /pendingNameClaimKey/);
  assert.match(claim[".validate"], /newData\.parent\(\)\.parent\(\)\.parent\(\)\.child\('players'/);
  assert.match(claim.name[".validate"], /\\x00/);
  assert.strictEqual(claim.$other[".validate"], false);

  assert.ok(roomRules.membership.activeGenerationId[".validate"].includes(
    "/^g_[A-Za-z0-9_-]{8,80}$/"
  ));

  [roomRules.publicPlayers.$profileId, roomRules.publicScores.$profileId].forEach((node) => {
    assert.match(node[".write"], /newData\.exists\(\)/);
    assert.ok(node.generationId);
    assert.ok(node.profileRevision);
  });
  assert.strictEqual(roomRules.playerStats[".write"], false);
  assert.match(roomRules.playerStats.$uid[".write"], /newData\.exists\(\)/);
});

run("ticket and presence writes are bound to stage and active generation", () => {
  const ticket = roomRules.tickets.$stageId.$uid;
  const privatePresence = roomRules.ticketPresence.$stageId.$uid;
  const publicPresence = roomRules.publicTicketPresence.$stageId.$profileId;
  [ticket, privatePresence, publicPresence].forEach((node) => {
    assert.match(node[".validate"], /generationId/);
    assert.match(node[".validate"], /stageId/);
  });
  assert.match(ticket[".validate"], /currentStageId/);
  assert.match(privatePresence[".validate"], /publicTicketPresence/);
  assert.match(publicPresence[".validate"], /ticketPresence/);
  assert.match(roomRules.tickets.$stageId[".write"], /!newData\.exists\(\)/);
  assert.match(roomRules.ticketPresence.$stageId[".write"], /!newData\.exists\(\)/);
  assert.match(roomRules.publicTicketPresence.$stageId[".write"], /!newData\.exists\(\)/);
});

run("player master and self stats writes are explicitly scoped", () => {
  assert.match(roomRules.playerStats.$uid[".write"], /auth\.uid === \$uid/);
  assert.match(rules.players.$uid[".read"], /auth\.uid === \$uid/);
  assert.match(rules.players.$uid[".read"], /!data\.exists\(\)/);
  assert.match(rules.players.$uid[".read"], /child\('elevator-game-live'\)\.child\('players'\)\.child\(\$uid\)\.exists\(\)/);
  assert.match(rules.players.$uid[".read"], /child\('elevator-game-live'\)\.child\('roles'\)\.child\('hosts'\)/);
  assert.match(rules.players.$uid[".write"], /auth\.uid === \$uid/);
  assert.match(rules.players.$uid[".write"], /roles'\)\.child\('hosts/);
  assert.match(rules.players.$uid[".write"], /stageSkillHistory/);
  assert.match(rules.players.$uid[".validate"], /currentSkill/);
  assert.strictEqual(rules.players.$uid.$other[".validate"], false);
  assert.match(roomRules.players.$uid.profileId[".validate"], /p_/);
  assert.match(roomRules.players.$uid.name[".validate"], /pendingName/);
});

run("completed game history is split into public summaries and scoped details", () => {
  assert.strictEqual(roomRules.completedGames[".read"], false);
  assert.strictEqual(roomRules.completedGames[".write"], false);
  assert.strictEqual(roomRules.completedGameSummaries[".read"], "auth != null");
  assert.match(roomRules.completedGameDetails[".read"], /roles'\)\.child\('hosts/);
  assert.strictEqual(roomRules.completedGamePlayerDetails[".read"], undefined);
  assert.strictEqual(roomRules.completedGamePlayerDetails[".write"], false);
  assert.match(roomRules.completedGamePlayerDetails.$uid[".read"], /auth\.uid === \$uid/);
  assert.strictEqual(roomRules.completedGamePlayerDetails.$uid[".write"], false);
  assert.strictEqual(roomRules.completedGamePublicDetails[".read"], "auth != null");
  assert.strictEqual(roomRules.historyPlayers[".read"], "auth != null");
  assert.strictEqual(roomRules.historyPlayers[".write"], false);

  [
    roomRules.completedGameSummaries,
    roomRules.completedGamePublicDetails,
    roomRules.completedGameDetails,
  ].forEach((historyRules) => {
    assert.strictEqual(historyRules[".write"], false);
    assert.match(historyRules.$gameId[".write"], /roles'\)\.child\('hosts/);
    assert.match(historyRules.$gameId[".write"], /newData\.exists\(\)/);
    assert.match(historyRules.$gameId[".validate"], /newData\.child\('gameId'\)\.val\(\) === \$gameId/);
  });

  const playerGameRules = roomRules.completedGamePlayerDetails.$uid.$gameId;
  assert.match(playerGameRules[".write"], /roles'\)\.child\('hosts/);
  assert.match(playerGameRules[".write"], /newData\.exists\(\)/);
  assert.match(playerGameRules[".validate"], /newData\.child\('gameId'\)\.val\(\) === \$gameId/);
  assert.match(roomRules.historyPlayers.$profileId[".write"], /roles'\)\.child\('hosts/);
  assert.match(roomRules.historyPlayers.$profileId[".write"], /newData\.exists\(\)/);
  assert.match(roomRules.historyPlayers.$profileId[".validate"], /currentSkill/);
  assert.doesNotMatch(roomRules.historyPlayers.$profileId[".validate"], /uuid|uid/);

  const summaryRules = roomRules.completedGameSummaries.$gameId;
  const publicDetailRules = roomRules.completedGamePublicDetails.$gameId;
  assert.strictEqual(summaryRules.$other[".validate"], false);
  assert.strictEqual(summaryRules.rankings[".validate"], "newData.hasChildren()");
  assert.strictEqual(summaryRules.stages[".validate"], "newData.hasChildren()");
  assert.strictEqual(summaryRules.rankings.$index.$other[".validate"], false);
  assert.strictEqual(summaryRules.stages.$index.$other[".validate"], false);
  assert.match(summaryRules.gameId[".validate"], /newData\.isString/);
  assert.match(summaryRules.rankings.$index.profileId[".validate"], /p_/);

  assert.strictEqual(publicDetailRules.$other[".validate"], false);
  assert.strictEqual(publicDetailRules.rankings[".validate"], "newData.hasChildren()");
  assert.strictEqual(publicDetailRules.stageResults[".validate"], "newData.hasChildren()");
  assert.strictEqual(publicDetailRules.rankings.$index.$other[".validate"], false);
  assert.strictEqual(publicDetailRules.stageResults.$stageId.$other[".validate"], false);
  assert.strictEqual(publicDetailRules.stageResults.$stageId.rankings[".validate"], "newData.hasChildren()");
  assert.strictEqual(publicDetailRules.stageResults.$stageId.rankings.$index.$other[".validate"], false);
  assert.match(publicDetailRules.stageResults.$stageId[".validate"], /child\('stageId'\)\.val\(\) === \$stageId/);
  assert.match(publicDetailRules.rankings.$index.profileId[".validate"], /p_/);
  assert.doesNotMatch(
    JSON.stringify({ summaryRules, publicDetailRules }),
    /uuid|ticket|prediction|breakdown|stageSkill|stageSkillHistory/
  );
});

run("firebase next-game config catalog is host scoped", () => {
  assert.match(roomRules.nextGameConfigs[".read"], /roles'\)\.child\('hosts/);
  assert.match(roomRules.nextGameConfigs[".write"], /roles'\)\.child\('hosts/);
});

run("operation logs are Host-only and legacy root archives are closed", () => {
  assert.match(roomRules.operations[".read"], /roles'\)\.child\('hosts/);
  assert.match(roomRules.operations[".write"], /roles'\)\.child\('hosts/);
  assert.strictEqual(rules.archives.$archiveId[".read"], false);
  assert.strictEqual(rules.archives.$archiveId[".write"], false);
  assert.match(roomRules.archive[".read"], /roles'\)\.child\('hosts/);
  assert.match(roomRules.archive[".write"], /roles'\)\.child\('hosts/);
});

run("room settings validate countdown and separated audio controls", () => {
  const settings = roomRules.roomSettings;
  assert.match(settings.countdownSeconds[".validate"], /newData\.isNumber/);
  assert.match(settings.countdownSeconds[".validate"], /newData\.val\(\) >= 1/);
  assert.match(settings.countdownSeconds[".validate"], /newData\.val\(\) <= 60/);
  assert.match(settings.countdownSeconds[".validate"], /% 1 === 0/);
  ["volume", "bgmVolume", "seVolume"].forEach((key) => {
    assert.match(settings[key][".validate"], /newData\.isNumber/);
    assert.match(settings[key][".validate"], /newData\.val\(\) >= 0/);
    assert.match(settings[key][".validate"], /newData\.val\(\) <= 1/);
  });
  ["muted", "bgmMuted", "seMuted"].forEach((key) => {
    assert.strictEqual(settings[key][".validate"], "newData.isBoolean()");
  });
  assert.strictEqual(settings.$other[".validate"], false);
});
