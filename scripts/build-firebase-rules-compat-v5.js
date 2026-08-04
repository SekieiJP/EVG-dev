#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "..");
const finalRulesPath = path.join(repositoryRoot, "firebase/database.rules.json");
const compatRulesPath = path.join(repositoryRoot, "firebase/database.rules.compat-v5.json");
const MEMBERSHIP_MARKER = "game-membership-v1";
const HOST = "auth != null && root.child('rooms').child($roomId).child('roles').child('hosts').child(auth.uid).val() === true";
const ROOT_MARKER = "root.child('rooms').child($roomId).child('meta').child('membershipSchemaVersion')";

const LEGACY = {
  publicValidate: "newData.hasChildren(['gameId', 'phase', 'roomVersion', 'currentStageIndex', 'currentStageId', 'playerCount', 'submittedCount', 'abstainedCount']) && (!data.exists() || newData.child('roomVersion').val() === data.child('roomVersion').val() + 1) && (!data.exists() || newData.child('gameId').val() !== data.child('gameId').val() || newData.child('phase').val() === data.child('phase').val() || (data.child('phase').val() === 'lobby' && newData.child('phase').val() === 'stage_intro') || (data.child('phase').val() === 'stage_intro' && newData.child('phase').val() === 'voting') || (data.child('phase').val() === 'voting' && newData.child('phase').val() === 'countdown') || (data.child('phase').val() === 'countdown' && newData.child('phase').val() === 'reveal') || (data.child('phase').val() === 'tallying' && newData.child('phase').val() === 'reveal') || (data.child('phase').val() === 'reveal' && newData.child('phase').val() === 'ranking') || (data.child('phase').val() === 'ranking' && (newData.child('phase').val() === 'stage_intro' || newData.child('phase').val() === 'final')))",
  playerWrite: `auth != null && (auth.uid === $uid || ${HOST})`,
  playerNameValidate: "newData.isString() && newData.val().length > 0 && newData.val().length <= 24 && (auth.uid === $uid || data.val() === newData.val() || !data.parent().child('pendingName').exists() || newData.val() === data.parent().child('pendingName').val())",
  pendingNameValidate: "newData.val() === null || (newData.isString() && newData.val().length <= 24)",
  publicPlayerWrite: `auth != null && (${HOST} || newData.parent().parent().child('publicProfileOwners').child($profileId).val() === auth.uid)`,
  publicPlayerValidate: "newData.hasChildren(['profileId', 'name', 'connected', 'order']) && newData.child('profileId').val() === $profileId && $profileId.matches(/^p_[a-z0-9]+$/)",
  publicOwnerWrite: `auth != null && (${HOST} || (newData.val() === auth.uid && newData.parent().parent().child('players').child(auth.uid).child('profileId').val() === $profileId))`,
  publicPresenceWrite: `auth != null && (${HOST} || newData.parent().parent().parent().child('publicProfileOwners').child($profileId).val() === auth.uid)`,
  publicPresenceValidate: "newData.hasChildren(['profileId', 'status']) && newData.child('profileId').val() === $profileId && $profileId.matches(/^p_[a-z0-9]+$/)",
  publicScoreWrite: HOST,
  publicScoreValidate: "newData.hasChildren(['profileId', 'name', 'total', 'order']) && newData.child('profileId').val() === $profileId && $profileId.matches(/^p_[a-z0-9]+$/)",
  playerStatsWrite: HOST,
  playerStatsChildWrite: `auth != null && (${HOST} || (auth.uid === $uid && root.child('players').child($uid).exists() && newData.child('currentSkill').val() === root.child('players').child($uid).child('currentSkill').val() && newData.child('stageSkillHistoryJson').val() === root.child('players').child($uid).child('stageSkillHistoryJson').val() && newData.child('appliedSkillStageIdsJson').val() === root.child('players').child($uid).child('appliedSkillStageIdsJson').val()))`,
  stageHostWrite: HOST,
  ticketWrite: "auth != null && auth.uid === $uid && root.child('rooms').child($roomId).child('public').child('phase').val().matches(/^(voting|countdown)$/)",
  presenceWrite: `auth != null && ((auth.uid === $uid && root.child('rooms').child($roomId).child('public').child('phase').val().matches(/^(voting|countdown)$/)) || ${HOST})`,
  scoreWrite: HOST,
};

function gated(finalExpression, legacyExpression) {
  return `((!${ROOT_MARKER}.exists() && (${legacyExpression})) || (${ROOT_MARKER}.val() === '${MEMBERSHIP_MARKER}' && (${finalExpression})))`;
}

function gatedValidation(finalExpression, legacyExpression, markerExpression) {
  return `((!${markerExpression}.exists() && (${legacyExpression})) || (${markerExpression}.val() === '${MEMBERSHIP_MARKER}' && (${finalExpression})))`;
}

function buildCompatRules(finalRules) {
  const compat = JSON.parse(JSON.stringify(finalRules));
  const room = compat.rules.rooms.$roomId;

  room.meta[".validate"] = `((!data.child('membershipSchemaVersion').exists() && !newData.child('membershipSchemaVersion').exists()) || (data.child('membershipSchemaVersion').val() === '${MEMBERSHIP_MARKER}' && (${room.meta[".validate"]})))`;
  room.public[".validate"] = gatedValidation(
    room.public[".validate"],
    LEGACY.publicValidate,
    "newData.parent().child('meta').child('membershipSchemaVersion')"
  );

  room.players.$uid[".write"] = gated(room.players.$uid[".write"], LEGACY.playerWrite);
  room.players.$uid[".validate"] = gatedValidation(
    room.players.$uid[".validate"],
    "true",
    "newData.parent().parent().child('meta').child('membershipSchemaVersion')"
  );
  room.players.$uid.name[".validate"] = gatedValidation(
    room.players.$uid.name[".validate"],
    LEGACY.playerNameValidate,
    "newData.parent().parent().parent().child('meta').child('membershipSchemaVersion')"
  );
  room.players.$uid.pendingName[".validate"] = gatedValidation(
    room.players.$uid.pendingName[".validate"],
    LEGACY.pendingNameValidate,
    "newData.parent().parent().parent().child('meta').child('membershipSchemaVersion')"
  );

  room.publicPlayers.$profileId[".write"] = gated(room.publicPlayers.$profileId[".write"], LEGACY.publicPlayerWrite);
  room.publicPlayers.$profileId[".validate"] = gatedValidation(
    room.publicPlayers.$profileId[".validate"],
    LEGACY.publicPlayerValidate,
    "newData.parent().parent().child('meta').child('membershipSchemaVersion')"
  );
  room.publicProfileOwners.$profileId[".write"] = gated(room.publicProfileOwners.$profileId[".write"], LEGACY.publicOwnerWrite);

  room.publicScores.$profileId[".write"] = gated(room.publicScores.$profileId[".write"], LEGACY.publicScoreWrite);
  room.publicScores.$profileId[".validate"] = gatedValidation(
    room.publicScores.$profileId[".validate"],
    LEGACY.publicScoreValidate,
    "newData.parent().parent().child('meta').child('membershipSchemaVersion')"
  );
  room.scores.$uid[".write"] = gated(room.scores.$uid[".write"], LEGACY.scoreWrite);
  room.scores.$uid[".validate"] = gatedValidation(
    room.scores.$uid[".validate"],
    "true",
    "newData.parent().parent().child('meta').child('membershipSchemaVersion')"
  );

  room.playerStats[".write"] = gated(room.playerStats[".write"], LEGACY.playerStatsWrite);
  room.playerStats.$uid[".write"] = gated(room.playerStats.$uid[".write"], LEGACY.playerStatsChildWrite);

  room.tickets.$stageId[".write"] = gated(room.tickets.$stageId[".write"], LEGACY.stageHostWrite);
  room.tickets.$stageId.$uid[".write"] = gated(room.tickets.$stageId.$uid[".write"], LEGACY.ticketWrite);
  room.tickets.$stageId.$uid[".validate"] = gatedValidation(
    room.tickets.$stageId.$uid[".validate"],
    "true",
    "newData.parent().parent().parent().child('meta').child('membershipSchemaVersion')"
  );

  room.ticketPresence.$stageId[".write"] = gated(room.ticketPresence.$stageId[".write"], LEGACY.stageHostWrite);
  room.ticketPresence.$stageId.$uid[".write"] = gated(room.ticketPresence.$stageId.$uid[".write"], LEGACY.presenceWrite);
  room.ticketPresence.$stageId.$uid[".validate"] = gatedValidation(
    room.ticketPresence.$stageId.$uid[".validate"],
    "true",
    "newData.parent().parent().parent().child('meta').child('membershipSchemaVersion')"
  );

  room.publicTicketPresence.$stageId[".write"] = gated(room.publicTicketPresence.$stageId[".write"], "false");
  room.publicTicketPresence.$stageId.$profileId[".write"] = gated(
    room.publicTicketPresence.$stageId.$profileId[".write"],
    LEGACY.publicPresenceWrite
  );
  room.publicTicketPresence.$stageId.$profileId[".validate"] = gatedValidation(
    room.publicTicketPresence.$stageId.$profileId[".validate"],
    LEGACY.publicPresenceValidate,
    "newData.parent().parent().parent().child('meta').child('membershipSchemaVersion')"
  );

  return compat;
}

function main() {
  const finalRules = JSON.parse(fs.readFileSync(finalRulesPath, "utf8"));
  const compat = buildCompatRules(finalRules);
  fs.writeFileSync(compatRulesPath, `${JSON.stringify(compat, null, 2)}\n`);
  process.stdout.write(`${path.relative(repositoryRoot, compatRulesPath)}\n`);
}

if (require.main === module) main();

module.exports = { buildCompatRules, MEMBERSHIP_MARKER };
