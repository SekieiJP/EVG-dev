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
  assert.match(roomRules.public[".validate"], /roomVersion/);
  assert.match(roomRules.public[".validate"], /data\.child\('roomVersion'\)\.val\(\) \+ 1/);
  assert.match(roomRules.public[".validate"], /lobby\|stage_intro\|voting\|countdown\|tallying\|reveal\|ranking\|final/);
});

