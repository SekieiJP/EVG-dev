const fs = require("fs");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");

const projectId = "evg-rules-test";
const roomId = "unit-room";

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
        },
      });
    });

    const host = env.authenticatedContext("host").database();
    const alice = env.authenticatedContext("alice").database();
    const stranger = env.authenticatedContext("stranger").database();

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
      [`rooms/${roomId}/results/should-not-commit`]: {
        stageId: "should-not-commit",
      },
    }));
    let rejectedSideEffect = null;
    await env.withSecurityRulesDisabled(async (context) => {
      rejectedSideEffect = await context.database().ref(`rooms/${roomId}/results/should-not-commit`).once("value");
    });
    if (rejectedSideEffect.exists()) throw new Error("version-conflicted side effect was partially committed");

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
