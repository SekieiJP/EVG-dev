const fs = require("fs");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");

const projectId = "evg-rules-test";
const roomId = "unit-room";
const productionRoomId = "elevator-game-live";
const versionRoomId = "version-room";

function publicNode(overrides = {}) {
  return Object.assign({
    gameId: "game-1",
    phase: "countdown",
    roomVersion: 4,
    currentStageIndex: 0,
    currentStageId: "stage-001",
    countdownEndsAt: "2026-07-29T00:00:00.000Z",
    tallyingEndsAt: "2026-07-29T00:00:03.000Z",
    animationStartedAt: null,
    animationSkippedAt: null,
    revealEndsAt: null,
  }, overrides);
}

async function main() {
  const env = await initializeTestEnvironment({
    projectId,
    database: {
      rules: fs.readFileSync("firebase/database.rules.json", "utf8"),
    },
  });
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      await context.database().ref().set({
        rooms: {
          [roomId]: {
            roles: { hosts: { host: true } },
            public: publicNode(),
            meta: {
              roomId,
              title: "Rules test",
              schemaVersion: "firebase-rtdb-v2",
              activeGameId: "game-1",
              status: "active",
              createdAt: "2026-07-29T00:00:00.000Z",
              updatedAt: "2026-07-29T00:00:00.000Z",
            },
          },
          [productionRoomId]: {
            roles: { hosts: { "production-host": true } },
            public: publicNode({
              gameId: "production-game",
              roomVersion: 20,
            }),
            meta: {
              roomId: productionRoomId,
              title: "Production rules test",
              schemaVersion: "firebase-rtdb-v2",
              activeGameId: "production-game",
              status: "active",
              createdAt: "2026-07-29T00:00:00.000Z",
              updatedAt: "2026-07-29T00:00:00.000Z",
            },
            players: {
              "missing-root": {
                name: "Missing Root",
                connected: true,
                joinedAt: "2026-07-29T00:00:00.000Z",
                lastSeenAt: "2026-07-29T00:00:00.000Z",
              },
            },
          },
          [versionRoomId]: {
            roles: { hosts: { host: true } },
          },
        },
        archives: {
          "legacy-archive": {
            archiveId: "legacy-archive",
            status: "exported",
          },
        },
      });
    });

    const host = env.authenticatedContext("host").database();
    const productionHost = env.authenticatedContext("production-host").database();
    const alice = env.authenticatedContext("alice").database();
    const stranger = env.authenticatedContext("stranger").database();

    await assertSucceeds(host.ref(`rooms/${roomId}/operations/rules-boundary`).set({
      at: "2026-07-29T00:00:00.000Z",
      actor: "host",
      action: "rules-boundary",
    }));
    const hostOperation = await assertSucceeds(
      host.ref(`rooms/${roomId}/operations/rules-boundary`).once("value")
    );
    if (hostOperation.child("action").val() !== "rules-boundary") {
      throw new Error("Host could not read the operation it wrote");
    }
    await assertFails(alice.ref(`rooms/${roomId}/operations`).once("value"));
    await assertFails(stranger.ref(`rooms/${roomId}/operations/rules-boundary`).once("value"));

    await assertSucceeds(host.ref(`rooms/${roomId}/archive`).set({
      status: "queued",
      gameId: "game-1",
      archiveId: "room-archive",
    }));
    const roomArchive = await assertSucceeds(
      host.ref(`rooms/${roomId}/archive`).once("value")
    );
    if (roomArchive.child("archiveId").val() !== "room-archive") {
      throw new Error("Host room archive access regressed");
    }
    await assertFails(stranger.ref(`rooms/${roomId}/archive`).once("value"));
    await assertFails(host.ref("archives/legacy-archive").once("value"));
    await assertFails(stranger.ref("archives/legacy-archive").once("value"));

    await assertSucceeds(host.ref(`rooms/${versionRoomId}/public`).set(publicNode({
      gameId: "version-game-1",
      phase: "lobby",
      roomVersion: 0,
      currentStageId: "",
      countdownEndsAt: null,
      tallyingEndsAt: null,
    })));
    await assertFails(host.ref(`rooms/${versionRoomId}/public`).set(publicNode({
      gameId: "version-game-2",
      phase: "lobby",
      roomVersion: 0,
      currentStageId: "",
      countdownEndsAt: null,
      tallyingEndsAt: null,
    })));
    await assertSucceeds(host.ref(`rooms/${versionRoomId}/public`).set(publicNode({
      gameId: "version-game-2",
      phase: "lobby",
      roomVersion: 1,
      currentStageId: "",
      countdownEndsAt: null,
      tallyingEndsAt: null,
    })));

    const missingRoot = await assertSucceeds(
      productionHost.ref("players/missing-root").once("value")
    );
    if (missingRoot.exists()) throw new Error("missing root player unexpectedly existed");
    await assertFails(stranger.ref("players/missing-root").once("value"));
    await assertFails(host.ref("players/missing-root").once("value"));
    await assertFails(productionHost.ref("players/not-a-current-participant").once("value"));

    await assertSucceeds(productionHost.ref().update({
      [`rooms/${productionRoomId}/public`]: publicNode({
        gameId: "production-game",
        phase: "reveal",
        roomVersion: 21,
        animationStartedAt: "2026-07-29T00:00:04.000Z",
      }),
      [`rooms/${productionRoomId}/meta`]: {
        roomId: productionRoomId,
        title: "Production rules test",
        schemaVersion: "firebase-rtdb-v3-skill-history",
        activeGameId: "production-game",
        status: "active",
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:05.000Z",
      },
      [`rooms/${productionRoomId}/playerStats/missing-root`]: {
        currentSkill: 70,
        stageSkillHistoryJson: "[30,40]",
        appliedSkillStageIdsJson: "[\"[\\\"production-game\\\",\\\"stage-001\\\"]\",\"[\\\"production-game\\\",\\\"stage-002\\\"]\"]",
        updatedAt: "2026-07-29T00:00:05.000Z",
      },
      [`rooms/${productionRoomId}/historyPlayers/p_missing_root`]: {
        profileId: "p_missing_root",
        name: "Missing Root",
        currentSkill: 70,
        updatedAt: "2026-07-29T00:00:05.000Z",
      },
      [`rooms/${productionRoomId}/operations/backfill`]: {
        at: "2026-07-29T00:00:05.000Z",
        actor: "host",
        action: "firebase-backfill-skill-history",
      },
      "players/missing-root": {
        name: "Missing Root",
        currentSkill: 70,
        stageSkillHistoryJson: "[30,40]",
        appliedSkillStageIdsJson: "[\"[\\\"production-game\\\",\\\"stage-001\\\"]\",\"[\\\"production-game\\\",\\\"stage-002\\\"]\"]",
        joinedAt: "2026-07-29T00:00:00.000Z",
        lastSeenAt: "2026-07-29T00:00:05.000Z",
        updatedAt: "2026-07-29T00:00:05.000Z",
        roomId: productionRoomId,
      },
    }));
    const migratedRoot = await assertSucceeds(
      productionHost.ref("players/missing-root").once("value")
    );
    if (migratedRoot.child("currentSkill").val() !== 70) {
      throw new Error("missing root backfill did not commit atomically");
    }

    await assertSucceeds(host.ref("players/preflight").set({
      name: "Preflight",
      currentSkill: 0,
      stageSkillHistoryJson: "[]",
      appliedSkillStageIdsJson: "[]",
      joinedAt: "2026-07-29T00:00:00.000Z",
      lastSeenAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
      roomId,
    }));
    await assertSucceeds(host.ref(`rooms/${roomId}/results`).once("value"));
    await assertFails(stranger.ref(`rooms/${roomId}/results`).once("value"));
    await assertSucceeds(host.ref().update({
      [`rooms/${roomId}/public`]: publicNode({
        phase: "reveal",
        roomVersion: 5,
        animationStartedAt: "2026-07-29T00:00:04.000Z",
      }),
      [`rooms/${roomId}/results/stage-001`]: {
        stageId: "stage-001",
        rankings: [{ uuid: "alice", name: "Alice", rank: 1, score: 20 }],
        players: { alice: { uuid: "alice", name: "Alice", score: 20 } },
      },
      [`rooms/${roomId}/scores/alice`]: {
        total: 20,
        updatedAt: "2026-07-29T00:00:04.000Z",
      },
      [`rooms/${roomId}/playerStats/alice`]: {
        currentSkill: 40,
        stageSkillHistoryJson: "[40]",
        appliedSkillStageIdsJson: "[\"stage-001\"]",
        updatedAt: "2026-07-29T00:00:04.000Z",
      },
      [`rooms/${roomId}/historyPlayers/p_alice`]: {
        profileId: "p_alice",
        name: "Alice",
        currentSkill: 40,
        updatedAt: "2026-07-29T00:00:04.000Z",
      },
      "players/alice": {
        name: "Alice",
        currentSkill: 40,
        stageSkillHistoryJson: "[40]",
        appliedSkillStageIdsJson: "[\"stage-001\"]",
        joinedAt: "2026-07-29T00:00:00.000Z",
        lastSeenAt: "2026-07-29T00:00:04.000Z",
        updatedAt: "2026-07-29T00:00:04.000Z",
        roomId,
      },
    }));

    await assertFails(host.ref().update({
      [`rooms/${roomId}/public`]: publicNode({
        phase: "ranking",
        roomVersion: 5,
      }),
      [`rooms/${roomId}/meta`]: {
        roomId,
        title: "Rules test",
        schemaVersion: "firebase-rtdb-v3-skill-history",
        activeGameId: "game-1",
        status: "active",
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:03.000Z",
      },
      [`rooms/${roomId}/results/should-not-commit`]: {
        stageId: "should-not-commit",
      },
    }));
    let rejectedSideEffect = null;
    await env.withSecurityRulesDisabled(async (context) => {
      rejectedSideEffect = await context.database().ref(`rooms/${roomId}/results/should-not-commit`).once("value");
    });
    if (rejectedSideEffect.exists()) throw new Error("version-conflicted side effect was partially committed");
    let rejectedSchemaVersion = null;
    await env.withSecurityRulesDisabled(async (context) => {
      rejectedSchemaVersion = await context.database().ref(`rooms/${roomId}/meta/schemaVersion`).once("value");
    });
    if (rejectedSchemaVersion.val() !== "firebase-rtdb-v2") {
      throw new Error("version-conflicted migration marker was partially committed");
    }

    await assertFails(host.ref(`rooms/${roomId}/results/stage-001`).set({
      stageId: "stage-001",
      rankings: [{ uuid: "alice", name: "Alice", rank: 1, score: 999 }],
      players: { alice: { uuid: "alice", name: "Alice", score: 999 } },
    }));

    await assertSucceeds(host.ref().update({
      [`rooms/${roomId}/public`]: publicNode({
        phase: "reveal",
        roomVersion: 6,
        animationStartedAt: "2026-07-29T00:00:04.000Z",
      }),
      [`rooms/${roomId}/meta`]: {
        roomId,
        title: "Rules test",
        schemaVersion: "firebase-rtdb-v3-skill-history",
        activeGameId: "game-1",
        status: "active",
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:05.000Z",
      },
      [`rooms/${roomId}/playerStats/alice`]: {
        currentSkill: 90,
        stageSkillHistoryJson: "[40,50]",
        appliedSkillStageIdsJson: "[\"[\\\"game-1\\\",\\\"stage-001\\\"]\",\"[\\\"game-0\\\",\\\"stage-001\\\"]\"]",
        updatedAt: "2026-07-29T00:00:05.000Z",
      },
      [`rooms/${roomId}/historyPlayers/p_alice`]: {
        profileId: "p_alice",
        name: "Alice",
        currentSkill: 90,
        updatedAt: "2026-07-29T00:00:05.000Z",
      },
      [`rooms/${roomId}/completedGameSummaries/game-1`]: {
        gameId: "game-1",
        title: "Rules test",
        finishedAt: "2026-07-29T00:00:05.000Z",
      },
      [`rooms/${roomId}/completedGameDetails/game-1`]: {
        gameId: "game-1",
        title: "Rules test",
      },
      "players/alice": {
        name: "Alice",
        currentSkill: 90,
        stageSkillHistoryJson: "[40,50]",
        appliedSkillStageIdsJson: "[\"[\\\"game-1\\\",\\\"stage-001\\\"]\",\"[\\\"game-0\\\",\\\"stage-001\\\"]\"]",
        joinedAt: "2026-07-29T00:00:00.000Z",
        lastSeenAt: "2026-07-29T00:00:05.000Z",
        updatedAt: "2026-07-29T00:00:05.000Z",
        roomId,
      },
    }));

    await assertSucceeds(host.ref().update({
      [`rooms/${roomId}/public`]: publicNode({
        phase: "reveal",
        roomVersion: 7,
        animationStartedAt: "2026-07-29T00:00:04.000Z",
      }),
      [`rooms/${roomId}/completedGameSummaries/game-1`]: {
        gameId: "game-1",
        title: "Rules test repaired",
        finishedAt: "2026-07-29T00:00:05.000Z",
        stageCount: 2,
      },
      [`rooms/${roomId}/completedGamePublicDetails/game-1`]: {
        gameId: "game-1",
        title: "Rules test repaired",
        stageResults: {
          "stage-001": { stageId: "stage-001", rankings: [] },
          "stage-002": { stageId: "stage-002", rankings: [] },
        },
      },
      [`rooms/${roomId}/completedGameDetails/game-1`]: {
        gameId: "game-1",
        title: "Rules test repaired",
        playerSnapshots: [{
          uuid: "alice",
          name: "Alice",
          skill: 90,
          stageSkillHistory: [40, 50],
        }],
        stageResults: {
          "stage-001": { stageId: "stage-001" },
          "stage-002": { stageId: "stage-002" },
        },
      },
      [`rooms/${roomId}/completedGamePlayerDetails/alice/game-1`]: {
        gameId: "game-1",
        stageResults: {
          "stage-001": { stageId: "stage-001" },
          "stage-002": { stageId: "stage-002" },
        },
      },
      [`rooms/${roomId}/archive`]: {
        status: "queued",
        gameId: "game-1",
        archiveId: "archive-game-1",
        requestedAt: "2026-07-29T00:00:06.000Z",
        pendingGameIdsJson: "[\"game-2\"]",
      },
    }));
    await assertSucceeds(host.ref(`rooms/${roomId}/archive`).transaction((archive) => {
      return Object.assign({}, archive || {}, {
        pendingGameIdsJson: "[\"game-2\",\"game-3\"]",
      });
    }));
    const queuedArchive = await assertSucceeds(
      host.ref(`rooms/${roomId}/archive`).once("value")
    );
    if (queuedArchive.val().pendingGameIdsJson !== "[\"game-2\",\"game-3\"]") {
      throw new Error("Host archive transaction did not preserve the pending queue");
    }
    await assertFails(alice.ref(`rooms/${roomId}/archive`).set({
      status: "exported",
      gameId: "game-1",
      archiveId: "archive-game-1",
    }));

    const gameTwo = {
      summary: {
        gameId: "game-2",
        title: "Rules second game",
        finishedAt: "2026-07-29T00:00:07.000Z",
      },
      publicDetail: {
        gameId: "game-2",
        title: "Rules second game",
        stageResults: {
          "stage-001": { stageId: "stage-001", rankings: [] },
        },
      },
      detail: {
        gameId: "game-2",
        title: "Rules second game",
        stageResults: {
          "stage-001": { stageId: "stage-001" },
        },
      },
      playerDetail: {
        gameId: "game-2",
        title: "Rules second game",
        stageResults: {
          "stage-001": { stageId: "stage-001" },
        },
      },
      profile: {
        profileId: "p_bob",
        name: "Bob",
        currentSkill: 20,
        updatedAt: "2026-07-29T00:00:07.000Z",
      },
    };
    await assertSucceeds(host.ref().update({
      [`rooms/${roomId}/completedGameSummaries/game-2`]: gameTwo.summary,
      [`rooms/${roomId}/completedGamePublicDetails/game-2`]: gameTwo.publicDetail,
      [`rooms/${roomId}/completedGameDetails/game-2`]: gameTwo.detail,
      [`rooms/${roomId}/completedGamePlayerDetails/alice/game-2`]: gameTwo.playerDetail,
      [`rooms/${roomId}/historyPlayers/p_bob`]: gameTwo.profile,
    }));

    const repairedGameTwo = {
      summary: Object.assign({}, gameTwo.summary, { title: "Rules second game repaired" }),
      publicDetail: Object.assign({}, gameTwo.publicDetail, { title: "Rules second game repaired" }),
      detail: Object.assign({}, gameTwo.detail, { title: "Rules second game repaired" }),
      playerDetail: Object.assign({}, gameTwo.playerDetail, { title: "Rules second game repaired" }),
      profile: Object.assign({}, gameTwo.profile, {
        currentSkill: 30,
        updatedAt: "2026-07-29T00:00:08.000Z",
      }),
    };
    await assertSucceeds(host.ref().update({
      [`rooms/${roomId}/completedGameSummaries/game-2`]: repairedGameTwo.summary,
      [`rooms/${roomId}/completedGamePublicDetails/game-2`]: repairedGameTwo.publicDetail,
      [`rooms/${roomId}/completedGameDetails/game-2`]: repairedGameTwo.detail,
      [`rooms/${roomId}/completedGamePlayerDetails/alice/game-2`]: repairedGameTwo.playerDetail,
      [`rooms/${roomId}/historyPlayers/p_bob`]: repairedGameTwo.profile,
    }));

    for (const parentPath of [
      "completedGameSummaries",
      "completedGamePublicDetails",
      "completedGameDetails",
      "completedGamePlayerDetails",
      "historyPlayers",
    ]) {
      await assertFails(host.ref(`rooms/${roomId}/${parentPath}`).set(null));
    }
    await assertFails(host.ref(`rooms/${roomId}/completedGamePlayerDetails/alice`).set(null));

    const shrinkWrites = [
      ["completedGameSummaries", { "game-1": { gameId: "game-1", title: "Only one" } }],
      ["completedGamePublicDetails", { "game-1": { gameId: "game-1", title: "Only one" } }],
      ["completedGameDetails", { "game-1": { gameId: "game-1", title: "Only one" } }],
      ["completedGamePlayerDetails", {
        alice: { "game-1": { gameId: "game-1", title: "Only one" } },
      }],
      ["historyPlayers", {
        p_alice: {
          profileId: "p_alice",
          name: "Alice",
          currentSkill: 40,
          updatedAt: "2026-07-29T00:00:05.000Z",
        },
      }],
    ];
    for (const [parentPath, value] of shrinkWrites) {
      await assertFails(host.ref(`rooms/${roomId}/${parentPath}`).set(value));
    }

    for (const childPath of [
      "completedGameSummaries/game-2",
      "completedGamePublicDetails/game-2",
      "completedGameDetails/game-2",
      "completedGamePlayerDetails/alice/game-2",
      "historyPlayers/p_bob",
    ]) {
      await assertFails(host.ref(`rooms/${roomId}/${childPath}`).set(null));
    }

    for (const childPath of [
      "completedGameSummaries/game-2",
      "completedGamePublicDetails/game-2",
      "completedGameDetails/game-2",
      "completedGamePlayerDetails/alice/game-2",
    ]) {
      await assertFails(host.ref(`rooms/${roomId}/${childPath}`).set({
        gameId: "wrong-game-id",
        title: "Wrong identity",
      }));
    }
    await assertFails(host.ref(`rooms/${roomId}/historyPlayers/p_bob`).set({
      profileId: "p_wrong",
      name: "Bob",
      currentSkill: 30,
      updatedAt: "2026-07-29T00:00:08.000Z",
    }));
    await assertFails(alice.ref(`rooms/${roomId}/completedGameSummaries/game-3`).set({
      gameId: "game-3",
      title: "Player forged history",
    }));

    await assertFails(host.ref().update({
      [`rooms/${roomId}/completedGameSummaries/game-2`]: Object.assign({}, repairedGameTwo.summary, {
        title: "Atomic write must not commit",
      }),
      [`rooms/${roomId}/historyPlayers`]: null,
      [`rooms/${roomId}/operations/rejected-history-shrink`]: {
        at: "2026-07-29T00:00:09.000Z",
        actor: "host",
        action: "rejected-history-shrink",
      },
    }));
    const preservedSummary = await assertSucceeds(
      host.ref(`rooms/${roomId}/completedGameSummaries/game-2`).once("value")
    );
    if (preservedSummary.child("title").val() !== "Rules second game repaired") {
      throw new Error("mixed rejected history update changed a repaired summary");
    }
    const rejectedOperation = await assertSucceeds(
      host.ref(`rooms/${roomId}/operations/rejected-history-shrink`).once("value")
    );
    if (rejectedOperation.exists()) {
      throw new Error("mixed rejected history update committed a side effect");
    }

    await assertSucceeds(host.ref(`rooms/${roomId}/historyPlayers/p_alice`).set({
      profileId: "p_alice",
      name: "Alice",
      currentSkill: 40,
      updatedAt: "2026-07-29T00:00:05.000Z",
    }));
    await assertFails(stranger.ref(`rooms/${roomId}/historyPlayers/p_alice`).set({
      profileId: "p_alice",
      name: "Forged",
      currentSkill: 999,
      updatedAt: "2026-07-29T00:00:05.000Z",
    }));
    await assertFails(alice.ref("players/alice").update({
      currentSkill: 999,
      stageSkillHistoryJson: "[999]",
      appliedSkillStageIdsJson: "[\"forged\"]",
    }));
    await assertFails(alice.ref(`rooms/${roomId}/playerStats/alice`).set({
      currentSkill: 999,
      stageSkillHistoryJson: "[999]",
      appliedSkillStageIdsJson: "[\"forged\"]",
      updatedAt: "2026-07-29T00:00:05.000Z",
    }));
    await assertFails(alice.ref(`rooms/${roomId}/historyPlayers/p_alice`).set({
      profileId: "p_alice",
      name: "Alice",
      currentSkill: 999,
      updatedAt: "2026-07-29T00:00:05.000Z",
    }));
    await assertSucceeds(alice.ref("players/alice").update({
      name: "Alice renamed",
      lastSeenAt: "2026-07-29T00:00:06.000Z",
      updatedAt: "2026-07-29T00:00:06.000Z",
    }));

    await assertSucceeds(host.ref(`rooms/${roomId}/nextGameConfigs/next`).set({
      configId: "next",
      status: "ACTIVE",
      config: { gameMeta: { title: "Next" }, stages: [{ stageId: "s1" }] },
    }));
    await assertFails(alice.ref(`rooms/${roomId}/nextGameConfigs/next`).once("value"));

    await assertSucceeds(host.ref(`rooms/${roomId}/roomSettings/countdownSeconds`).set(10));
    await assertFails(host.ref(`rooms/${roomId}/roomSettings/countdownSeconds`).set(0));
    await assertFails(host.ref(`rooms/${roomId}/roomSettings/countdownSeconds`).set(1.5));
    await assertFails(host.ref(`rooms/${roomId}/roomSettings/countdownSeconds`).set(61));
    await assertFails(alice.ref(`rooms/${roomId}/roomSettings/countdownSeconds`).set(20));

    await assertSucceeds(host.ref(`rooms/${roomId}/completedGamePublicDetails/game-0`).set({
      gameId: "game-0",
      rankings: [{ profileId: "p_alice", name: "Alice", rank: 1, score: 20 }],
      stageResults: {
        "stage-001": {
          stageId: "stage-001",
          rankings: [{ profileId: "p_alice", name: "Alice", rank: 1, score: 20 }],
        },
      },
    }));
    const publicHistory = await assertSucceeds(alice.ref(`rooms/${roomId}/completedGamePublicDetails/game-0`).once("value"));
    if (JSON.stringify(publicHistory.val()).includes('"uuid"')) throw new Error("public history exposed an internal uuid");
    await assertFails(alice.ref(`rooms/${roomId}/completedGameDetails/game-0`).once("value"));

    console.log("ok firebase rules emulator atomic/history/config coverage");
  } finally {
    await env.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
