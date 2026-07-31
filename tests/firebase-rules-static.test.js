const assert = require("assert");
const fs = require("fs");

const rules = JSON.parse(fs.readFileSync("firebase/database.rules.json", "utf8")).rules;
const roomRules = rules.rooms.$roomId;
const rulesText = JSON.stringify(rules);

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
  assert.match(validation, /lobby\|stage_intro\|voting\|countdown\|tallying\|reveal\|ranking\|final/);
});

run("stage results allow create or delete but never overwrite", () => {
  assert.match(roomRules.results[".read"], /roles'\)\.child\('hosts/);
  assert.strictEqual(roomRules.results[".write"], false);
  assert.match(roomRules.results.$stageId[".write"], /!data\.exists\(\) \|\| newData\.val\(\) === null/);
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
