const fs = require("fs");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const Projection = require("../game/assets/js/public-projection");

const projectId = "evg-rules-test";
const roomId = "unit-room";
const productionRoomId = "elevator-game-live";
const versionRoomId = "version-room";
const privacyRoomId = "privacy-room";
const strictRoomId = "membership-room";
const activeGenerationId = "g_membership0001";
const nextGenerationId = "g_membership0002";
const aliceProfileId = Projection.publicProfileId("alice");
const bobProfileId = Projection.publicProfileId("bob");
const missingRootProfileId = Projection.publicProfileId("missing-root");

function privacyRoomNode() {
  const stageId = "privacy-stage";
  const calculatedAt = "2026-08-01T00:00:00.000Z";
  const publicPlayer = (profileId, name, order) => ({ profileId, name, connected: true, order });
  const publicScore = (profileId, name, total, order) => ({ profileId, name, total, order });
  const publicResultPlayer = (profileId, name, order) => ({ profileId, name, order });
  const checkpointScore = (profileId, score, delta) => ({ profileId, score, delta, reason: delta ? "上昇報酬" : "変動なし" });
  return {
    roles: { hosts: { "privacy-host": true } },
    meta: {
      roomId: privacyRoomId,
      title: "Privacy rules test",
      schemaVersion: "firebase-rtdb-v4-public-projection",
      activeGameId: "privacy-game",
      status: "active",
      createdAt: calculatedAt,
      updatedAt: calculatedAt,
    },
    public: publicNode({
      gameId: "privacy-game",
      phase: "countdown",
      roomVersion: 4,
      currentStageId: stageId,
    }),
    config: {
      schemaVersion: "1.0.0",
      gameMeta: { title: "Privacy rules test", apiKey: "must-not-be-readable" },
      stages: [{
        stageId,
        name: "Privacy stage",
        params: { N: 2, X: 2, P: 10, Q: 1 },
        events: [{
          type: "E1_prediction",
          question: "Who wins?",
          answerFormat: "player",
          correctAnswer: "alice",
          scoreOnCorrect: 1,
          scoreOnWrong: 0,
          scoreOnNoAnswer: 0,
        }],
      }],
    },
    publicConfig: {
      schemaVersion: "1.0.0",
      gameMeta: { title: "Privacy rules test" },
      stages: [{
        stageId,
        name: "Privacy stage",
        params: { N: 2, X: 2, P: 10, Q: 1 },
        events: [{
          type: "E1_prediction",
          question: "Who wins?",
          answerFormat: "player",
          scoreOnCorrect: 1,
          scoreOnWrong: 0,
          scoreOnNoAnswer: 0,
        }],
      }],
    },
    players: {
      alice: { profileId: aliceProfileId, name: "Alice", connected: true, joinedAt: calculatedAt, lastSeenAt: calculatedAt },
      bob: { profileId: bobProfileId, name: "Bob", connected: true, joinedAt: calculatedAt, lastSeenAt: calculatedAt },
    },
    playerStats: {
      alice: { currentSkill: 0, stageSkillHistoryJson: "[]", appliedSkillStageIdsJson: "[]", updatedAt: calculatedAt },
      bob: { currentSkill: 0, stageSkillHistoryJson: "[]", appliedSkillStageIdsJson: "[]", updatedAt: calculatedAt },
    },
    tickets: {
      [stageId]: {
        alice: { uuid: "alice", boardFloor: 1, exitFloor: 2, predictions: ["bob"], abstained: false, submittedAt: calculatedAt },
      },
    },
    ticketPresence: {
      [stageId]: {
        alice: { status: "submitted", updatedAt: calculatedAt },
        bob: { status: "none", updatedAt: calculatedAt },
      },
    },
    results: {
      [stageId]: {
        stageId,
        players: {
          alice: { uuid: "alice", name: "Alice", ticket: { uuid: "alice", predictions: ["bob"] }, score: 10, stageSkill: 40 },
          bob: { uuid: "bob", name: "Bob", ticket: null, score: 0, stageSkill: null },
        },
        rankings: [{ uuid: "alice", name: "Alice", rank: 1, score: 10 }],
      },
    },
    scores: {
      alice: { total: 10, updatedAt: calculatedAt },
      bob: { total: 0, updatedAt: calculatedAt },
    },
    publicPlayers: {
      [aliceProfileId]: publicPlayer(aliceProfileId, "Alice", 0),
      [bobProfileId]: publicPlayer(bobProfileId, "Bob", 1),
    },
    publicProfileOwners: {
      [aliceProfileId]: "alice",
      [bobProfileId]: "bob",
    },
    publicTicketPresence: {
      [stageId]: {
        [aliceProfileId]: { profileId: aliceProfileId, status: "submitted" },
        [bobProfileId]: { profileId: bobProfileId, status: "none" },
      },
    },
    publicScores: {
      [aliceProfileId]: publicScore(aliceProfileId, "Alice", 10, 0),
      [bobProfileId]: publicScore(bobProfileId, "Bob", 0, 1),
    },
    publicResults: {
      [stageId]: {
        gameId: "privacy-game",
        stageId,
        stageName: "Privacy stage",
        calculatedAt,
        floorCount: 2,
        players: {
          [aliceProfileId]: publicResultPlayer(aliceProfileId, "Alice", 0),
          [bobProfileId]: publicResultPlayer(bobProfileId, "Bob", 1),
        },
        timeline: [
          { floor: 1, boarding: [aliceProfileId], blocked: [], exiting: [], passengersBeforeCheck: [], passengersAfterCheck: [aliceProfileId], forcedOff: [], danger: false, scoreChanged: true },
          { floor: 2, boarding: [], blocked: [], exiting: [aliceProfileId], passengersBeforeCheck: [aliceProfileId], passengersAfterCheck: [aliceProfileId], forcedOff: [], danger: false, scoreChanged: false },
        ],
        scoreCheckpoints: [
          { floor: 0, scores: { [aliceProfileId]: checkpointScore(aliceProfileId, 0, 0), [bobProfileId]: checkpointScore(bobProfileId, 0, 0) } },
          { floor: 1, scores: { [aliceProfileId]: checkpointScore(aliceProfileId, 10, 10), [bobProfileId]: checkpointScore(bobProfileId, 0, 0) } },
          { floor: 2, scores: { [aliceProfileId]: checkpointScore(aliceProfileId, 10, 0), [bobProfileId]: checkpointScore(bobProfileId, 0, 0) } },
        ],
        rankings: [{ profileId: aliceProfileId, name: "Alice", rank: 1, score: 10 }],
      },
    },
  };
}

function publicNode(overrides = {}) {
  return Object.assign({
    gameId: "game-1",
    phase: "countdown",
    roomVersion: 4,
    currentStageIndex: 0,
    currentStageId: "stage-001",
    playerCount: 0,
    submittedCount: 0,
    abstainedCount: 0,
    countdownEndsAt: "2026-07-29T00:00:00.000Z",
    tallyingEndsAt: "2026-07-29T00:00:03.000Z",
    animationStartedAt: null,
    animationSkippedAt: null,
    revealEndsAt: null,
  }, overrides);
}

function strictMembershipRoomNode() {
  const at = "2026-08-01T00:00:00.000Z";
  const uid = "strict-alice";
  const profileId = Projection.publicProfileId(uid);
  return {
    roles: { hosts: { "strict-host": true } },
    meta: {
      roomId: strictRoomId,
      title: "Membership rules test",
      schemaVersion: "firebase-rtdb-v5-membership-generation",
      membershipSchemaVersion: "game-membership-v1",
      activeGameId: "membership-game-1",
      status: "active",
      createdAt: at,
      updatedAt: at,
    },
    membership: { activeGenerationId },
    public: publicNode({
      gameId: "membership-game-1",
      activeGenerationId,
      phase: "countdown",
      roomVersion: 1,
      currentStageId: "stage-001",
      playerCount: 1,
    }),
    players: {
      [uid]: {
        profileId,
        name: "Strict Alice",
        connected: true,
        joinedAt: at,
        lastSeenAt: at,
        generationId: activeGenerationId,
        profileRevision: 1,
        nameClaimKey: "Strict Alice",
      },
    },
    publicProfileOwners: { [profileId]: uid },
    publicPlayers: {
      [profileId]: {
        profileId,
        name: "Strict Alice",
        connected: true,
        order: 0,
        generationId: activeGenerationId,
        profileRevision: 1,
      },
    },
    nameClaims: {
      [activeGenerationId]: {
        "Strict Alice": {
          ownerUid: uid,
          profileId,
          generationId: activeGenerationId,
          name: "Strict Alice",
        },
      },
    },
    scores: {
      [uid]: { total: 0, updatedAt: at, generationId: activeGenerationId },
    },
    publicScores: {
      [profileId]: {
        profileId,
        name: "Strict Alice",
        total: 0,
        order: 0,
        generationId: activeGenerationId,
        profileRevision: 1,
      },
    },
  };
}

function strictJoinUpdates(uid, name, order) {
  const at = "2026-08-01T00:00:01.000Z";
  const profileId = Projection.publicProfileId(uid);
  return {
    [`players/${uid}`]: {
      name,
      currentSkill: 0,
      stageSkillHistoryJson: "[]",
      appliedSkillStageIdsJson: "[]",
      joinedAt: at,
      lastSeenAt: at,
      updatedAt: at,
      roomId: strictRoomId,
    },
    [`rooms/${strictRoomId}/players/${uid}`]: {
      profileId,
      name,
      connected: true,
      joinedAt: at,
      lastSeenAt: at,
      generationId: activeGenerationId,
      profileRevision: 1,
      nameClaimKey: name,
    },
    [`rooms/${strictRoomId}/publicProfileOwners/${profileId}`]: uid,
    [`rooms/${strictRoomId}/publicPlayers/${profileId}`]: {
      profileId,
      name,
      connected: true,
      order,
      generationId: activeGenerationId,
      profileRevision: 1,
    },
    [`rooms/${strictRoomId}/nameClaims/${activeGenerationId}/${name}`]: {
      ownerUid: uid,
      profileId,
      generationId: activeGenerationId,
      name,
    },
    [`rooms/${strictRoomId}/scores/${uid}`]: {
      total: 0,
      updatedAt: at,
      generationId: activeGenerationId,
    },
    [`rooms/${strictRoomId}/publicScores/${profileId}`]: {
      profileId,
      name,
      total: 0,
      order,
      generationId: activeGenerationId,
      profileRevision: 1,
    },
  };
}

function publicHistoryRanking(overrides = {}) {
  return Object.assign({
    profileId: aliceProfileId,
    name: "Alice",
    rank: 1,
    score: 20,
  }, overrides);
}

function completedGameSummary(gameId, overrides = {}) {
  return Object.assign({
    gameId,
    title: "Rules history",
    finishedAt: "2026-07-29T00:00:05.000Z",
    interrupted: false,
    finalPhase: "final",
    rankings: [publicHistoryRanking()],
    playerCount: 1,
    stageCount: 1,
    stages: [{ stageId: "stage-001", name: "Stage 1" }],
  }, overrides);
}

function completedGamePublicDetail(gameId, overrides = {}) {
  return Object.assign({
    gameId,
    title: "Rules history",
    finishedAt: "2026-07-29T00:00:05.000Z",
    interrupted: false,
    finalPhase: "final",
    rankings: [publicHistoryRanking()],
    stageResults: {
      "stage-001": {
        stageId: "stage-001",
        stageName: "Stage 1",
        calculatedAt: "2026-07-29T00:00:04.000Z",
        participantCount: 1,
        rankings: [publicHistoryRanking()],
      },
    },
  }, overrides);
}

async function main() {
  const env = await initializeTestEnvironment({
    projectId,
    database: {
      rules: fs.readFileSync("firebase/database.rules.compat-v5.json", "utf8"),
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
          [privacyRoomId]: privacyRoomNode(),
          [strictRoomId]: strictMembershipRoomNode(),
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
    const bob = env.authenticatedContext("bob").database();
    const stranger = env.authenticatedContext("stranger").database();
    const privacyHost = env.authenticatedContext("privacy-host").database();
    const strictHost = env.authenticatedContext("strict-host").database();
    const strictAlice = env.authenticatedContext("strict-alice").database();
    const guest = env.unauthenticatedContext().database();

    await assertSucceeds(strictHost.ref(`rooms/${strictRoomId}/nameClaims`).once("value"));
    await assertFails(strictAlice.ref(`rooms/${strictRoomId}/nameClaims`).once("value"));
    await assertSucceeds(strictAlice.ref(
      `rooms/${strictRoomId}/nameClaims/${activeGenerationId}/Strict Alice`
    ).once("value"));

    await assertSucceeds(privacyHost.ref(`rooms/${privacyRoomId}/config`).once("value"));
    await assertFails(alice.ref(`rooms/${privacyRoomId}/config`).once("value"));
    await assertFails(alice.ref(`rooms/${privacyRoomId}/players`).once("value"));
    await assertSucceeds(alice.ref(`rooms/${privacyRoomId}/players/alice`).once("value"));
    await assertFails(alice.ref(`rooms/${privacyRoomId}/players/bob`).once("value"));
    await assertFails(alice.ref(`rooms/${privacyRoomId}/tickets/privacy-stage`).once("value"));
    await assertSucceeds(alice.ref(`rooms/${privacyRoomId}/tickets/privacy-stage/alice`).once("value"));
    await assertFails(alice.ref(`rooms/${privacyRoomId}/ticketPresence/privacy-stage`).once("value"));
    await assertSucceeds(alice.ref(`rooms/${privacyRoomId}/ticketPresence/privacy-stage/alice`).once("value"));
    await assertFails(alice.ref(`rooms/${privacyRoomId}/results/privacy-stage`).once("value"));
    await assertSucceeds(alice.ref(`rooms/${privacyRoomId}/results/privacy-stage/players/alice`).once("value"));
    await assertFails(alice.ref(`rooms/${privacyRoomId}/results/privacy-stage/players/bob`).once("value"));
    await assertFails(alice.ref(`rooms/${privacyRoomId}/scores`).once("value"));
    await assertSucceeds(alice.ref(`rooms/${privacyRoomId}/scores/alice`).once("value"));
    await assertFails(alice.ref(`rooms/${privacyRoomId}/scores/bob`).once("value"));

    for (const publicPath of [
      "publicConfig",
      "publicPlayers",
      "publicTicketPresence/privacy-stage",
      "publicResults/privacy-stage",
      "publicScores",
    ]) {
      await assertSucceeds(stranger.ref(`rooms/${privacyRoomId}/${publicPath}`).once("value"));
      await assertFails(guest.ref(`rooms/${privacyRoomId}/${publicPath}`).once("value"));
    }
    await assertFails(alice.ref(`rooms/${privacyRoomId}/publicProfileOwners`).once("value"));
    await assertSucceeds(alice.ref(`rooms/${privacyRoomId}/publicProfileOwners/${aliceProfileId}`).once("value"));
    await assertFails(alice.ref(`rooms/${privacyRoomId}/publicProfileOwners/${bobProfileId}`).once("value"));

    const newbieProfileId = Projection.publicProfileId("newbie");
    const joinedAt = "2026-08-01T00:00:01.000Z";
    const newbie = env.authenticatedContext("newbie").database();
    await assertFails(newbie.ref(`rooms/${privacyRoomId}/publicPlayers/${newbieProfileId}`).set({
      profileId: newbieProfileId,
      name: "Unowned",
      connected: true,
      order: 2,
    }));
    await assertSucceeds(newbie.ref().update({
      [`rooms/${privacyRoomId}/players/newbie`]: {
        profileId: newbieProfileId,
        name: "Newbie",
        connected: true,
        joinedAt,
        lastSeenAt: joinedAt,
      },
      [`rooms/${privacyRoomId}/publicProfileOwners/${newbieProfileId}`]: "newbie",
      [`rooms/${privacyRoomId}/publicPlayers/${newbieProfileId}`]: {
        profileId: newbieProfileId,
        name: "Newbie",
        connected: true,
        order: 2,
      },
      "players/newbie": {
        name: "Newbie",
        currentSkill: 0,
        stageSkillHistoryJson: "[]",
        appliedSkillStageIdsJson: "[]",
        joinedAt,
        lastSeenAt: joinedAt,
        updatedAt: joinedAt,
        roomId: privacyRoomId,
      },
    }));
    await assertSucceeds(newbie.ref().update({
      [`rooms/${privacyRoomId}/tickets/privacy-stage/newbie`]: {
        uuid: "newbie",
        boardFloor: 1,
        exitFloor: 2,
        predictions: [aliceProfileId],
        abstained: false,
        submittedAt: joinedAt,
      },
      [`rooms/${privacyRoomId}/ticketPresence/privacy-stage/newbie`]: {
        status: "submitted",
        updatedAt: joinedAt,
      },
      [`rooms/${privacyRoomId}/publicTicketPresence/privacy-stage/${newbieProfileId}`]: {
        profileId: newbieProfileId,
        status: "submitted",
      },
    }));

    const legacyShape = env.authenticatedContext("legacy-shape").database();
    await assertFails(legacyShape.ref().update({
      [`rooms/${strictRoomId}/players/legacy-shape`]: {
        profileId: Projection.publicProfileId("legacy-shape"),
        name: "Legacy Shape",
        connected: true,
        joinedAt,
        lastSeenAt: joinedAt,
      },
      [`rooms/${strictRoomId}/publicPlayers/${Projection.publicProfileId("legacy-shape")}`]: {
        profileId: Projection.publicProfileId("legacy-shape"),
        name: "Legacy Shape",
        connected: true,
        order: 2,
      },
    }));

    const claimA = env.authenticatedContext("claim-a").database();
    const claimB = env.authenticatedContext("claim-b").database();
    const duplicateJoinResults = await Promise.allSettled([
      claimA.ref().update(strictJoinUpdates("claim-a", "Same Name", 2)),
      claimB.ref().update(strictJoinUpdates("claim-b", "Same Name", 3)),
    ]);
    if (duplicateJoinResults.filter((result) => result.status === "fulfilled").length !== 1) {
      throw new Error(`same-name claim race did not produce exactly one winner: ${JSON.stringify(duplicateJoinResults.map((item) => item.status))}`);
    }
    let duplicateClaim = null;
    await env.withSecurityRulesDisabled(async (context) => {
      duplicateClaim = await context.database().ref(
        `rooms/${strictRoomId}/nameClaims/${activeGenerationId}/Same Name`
      ).once("value");
    });
    if (!duplicateClaim.exists() || !["claim-a", "claim-b"].includes(duplicateClaim.child("ownerUid").val())) {
      throw new Error("same-name claim winner was not persisted");
    }

    const statsNew = env.authenticatedContext("stats-new").database();
    const statsNewProfile = {
      currentSkill: 0,
      stageSkillHistoryJson: "[]",
      appliedSkillStageIdsJson: "[]",
      updatedAt: "2026-08-01T00:00:01.000Z",
    };
    await assertFails(statsNew.ref().update(Object.assign(
      strictJoinUpdates("stats-new", "Stats New", 4),
      { [`rooms/${strictRoomId}/playerStats/stats-new`]: statsNewProfile }
    )));
    await assertSucceeds(statsNew.ref().update(strictJoinUpdates("stats-new", "Stats New", 4)));
    await assertSucceeds(statsNew.ref(
      `rooms/${strictRoomId}/playerStats/stats-new`
    ).set(statsNewProfile));

    const strictAliceProfileId = Projection.publicProfileId("strict-alice");
    await assertSucceeds(strictAlice.ref().update({
      [`rooms/${strictRoomId}/players/strict-alice`]: {
        profileId: strictAliceProfileId,
        name: "Strict Alice",
        pendingName: "Strict Alicia",
        connected: true,
        joinedAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:02.000Z",
        generationId: activeGenerationId,
        profileRevision: 2,
        nameClaimKey: "Strict Alice",
        pendingNameClaimKey: "Strict Alicia",
      },
      [`rooms/${strictRoomId}/publicPlayers/${strictAliceProfileId}`]: {
        profileId: strictAliceProfileId,
        name: "Strict Alice",
        connected: true,
        order: 0,
        generationId: activeGenerationId,
        profileRevision: 2,
      },
      [`rooms/${strictRoomId}/publicScores/${strictAliceProfileId}`]: {
        profileId: strictAliceProfileId,
        name: "Strict Alice",
        total: 0,
        order: 0,
        generationId: activeGenerationId,
        profileRevision: 2,
      },
      [`rooms/${strictRoomId}/nameClaims/${activeGenerationId}/Strict Alicia`]: {
        ownerUid: "strict-alice",
        profileId: strictAliceProfileId,
        generationId: activeGenerationId,
        name: "Strict Alicia",
      },
    }));
    await assertFails(strictAlice.ref().update({
      [`rooms/${strictRoomId}/players/strict-alice/pendingName`]: "Stale Revision",
      [`rooms/${strictRoomId}/players/strict-alice/pendingNameClaimKey`]: "Stale Revision",
      [`rooms/${strictRoomId}/players/strict-alice/profileRevision`]: 2,
    }));
    await assertSucceeds(strictAlice.ref().update({
      [`rooms/${strictRoomId}/players/strict-alice`]: {
        profileId: strictAliceProfileId,
        name: "Strict Alice",
        connected: true,
        joinedAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:03.000Z",
        generationId: activeGenerationId,
        profileRevision: 3,
        nameClaimKey: "Strict Alice",
      },
      [`rooms/${strictRoomId}/publicPlayers/${strictAliceProfileId}/profileRevision`]: 3,
      [`rooms/${strictRoomId}/publicScores/${strictAliceProfileId}/profileRevision`]: 3,
      [`rooms/${strictRoomId}/nameClaims/${activeGenerationId}/Strict Alicia`]: null,
    }));
    await assertFails(strictHost.ref().update({
      [`rooms/${strictRoomId}/players/strict-alice`]: {
        profileId: strictAliceProfileId,
        name: "Strict Alicia",
        connected: true,
        joinedAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:02.000Z",
        generationId: activeGenerationId,
        profileRevision: 3,
        nameClaimKey: "Strict Alicia",
      },
      [`rooms/${strictRoomId}/publicPlayers/${strictAliceProfileId}`]: {
        profileId: strictAliceProfileId,
        name: "Strict Alicia",
        connected: true,
        order: 0,
        generationId: activeGenerationId,
        profileRevision: 3,
      },
      [`rooms/${strictRoomId}/publicScores/${strictAliceProfileId}`]: {
        profileId: strictAliceProfileId,
        name: "Strict Alicia",
        total: 0,
        order: 0,
        generationId: activeGenerationId,
        profileRevision: 3,
      },
      [`rooms/${strictRoomId}/nameClaims/${activeGenerationId}/Strict Alice`]: null,
      [`rooms/${strictRoomId}/nameClaims/${activeGenerationId}/Strict Alicia`]: {
        ownerUid: "strict-alice",
        profileId: strictAliceProfileId,
        generationId: activeGenerationId,
        name: "Strict Alicia",
      },
    }));

    await assertSucceeds(strictHost.ref().update({
      [`rooms/${strictRoomId}/meta`]: {
        roomId: strictRoomId,
        title: "Membership rules test",
        schemaVersion: "firebase-rtdb-v5-membership-generation",
        membershipSchemaVersion: "game-membership-v1",
        activeGameId: "membership-game-2",
        status: "active",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:04.000Z",
      },
      [`rooms/${strictRoomId}/membership`]: { activeGenerationId: nextGenerationId },
      [`rooms/${strictRoomId}/public`]: publicNode({
        gameId: "membership-game-2",
        activeGenerationId: nextGenerationId,
        phase: "voting",
        roomVersion: 2,
        currentStageId: "stage-001",
        playerCount: 1,
        countdownEndsAt: null,
        tallyingEndsAt: null,
      }),
      [`rooms/${strictRoomId}/players/strict-alice`]: {
        profileId: strictAliceProfileId,
        name: "Strict Alice",
        connected: true,
        joinedAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:04.000Z",
        generationId: nextGenerationId,
        profileRevision: 4,
        nameClaimKey: "Strict Alice",
      },
      [`rooms/${strictRoomId}/publicPlayers/${strictAliceProfileId}`]: {
        profileId: strictAliceProfileId,
        name: "Strict Alice",
        connected: true,
        order: 0,
        generationId: nextGenerationId,
        profileRevision: 4,
      },
      [`rooms/${strictRoomId}/nameClaims/${nextGenerationId}/Strict Alice`]: {
        ownerUid: "strict-alice",
        profileId: strictAliceProfileId,
        generationId: nextGenerationId,
        name: "Strict Alice",
      },
      [`rooms/${strictRoomId}/scores/strict-alice`]: {
        total: 0,
        updatedAt: "2026-08-01T00:00:04.000Z",
        generationId: nextGenerationId,
      },
      [`rooms/${strictRoomId}/publicScores/${strictAliceProfileId}`]: {
        profileId: strictAliceProfileId,
        name: "Strict Alice",
        total: 0,
        order: 0,
        generationId: nextGenerationId,
        profileRevision: 4,
      },
    }));

    const staleJoin = env.authenticatedContext("stale-generation").database();
    await assertFails(staleJoin.ref().update(strictJoinUpdates("stale-generation", "Stale Generation", 4)));
    const ticketAt = "2026-08-01T00:00:05.000Z";
    await assertFails(strictAlice.ref().update({
      [`rooms/${strictRoomId}/tickets/stage-001/strict-alice`]: {
        uuid: "strict-alice",
        stageId: "stage-001",
        generationId: activeGenerationId,
        boardFloor: 1,
        exitFloor: 2,
        predictions: [],
        abstained: false,
        submittedAt: ticketAt,
      },
      [`rooms/${strictRoomId}/ticketPresence/stage-001/strict-alice`]: {
        status: "submitted",
        stageId: "stage-001",
        generationId: activeGenerationId,
        updatedAt: ticketAt,
      },
      [`rooms/${strictRoomId}/publicTicketPresence/stage-001/${strictAliceProfileId}`]: {
        profileId: strictAliceProfileId,
        status: "submitted",
        stageId: "stage-001",
        generationId: activeGenerationId,
      },
    }));
    await assertSucceeds(strictAlice.ref().update({
      [`rooms/${strictRoomId}/tickets/stage-001/strict-alice`]: {
        uuid: "strict-alice",
        stageId: "stage-001",
        generationId: nextGenerationId,
        boardFloor: 1,
        exitFloor: 2,
        predictions: [],
        abstained: false,
        submittedAt: ticketAt,
      },
      [`rooms/${strictRoomId}/ticketPresence/stage-001/strict-alice`]: {
        status: "submitted",
        stageId: "stage-001",
        generationId: nextGenerationId,
        updatedAt: ticketAt,
      },
      [`rooms/${strictRoomId}/publicTicketPresence/stage-001/${strictAliceProfileId}`]: {
        profileId: strictAliceProfileId,
        status: "submitted",
        stageId: "stage-001",
        generationId: nextGenerationId,
      },
    }));
    await assertFails(strictAlice.ref(`rooms/${strictRoomId}/tickets/stage-001/strict-alice`).set(null));
    await assertFails(strictAlice.ref(`rooms/${strictRoomId}/nameClaims/${nextGenerationId}/Strict Alice`).set(null));
    await assertFails(strictHost.ref(`rooms/${strictRoomId}/players/strict-alice`).set(null));
    await assertSucceeds(strictHost.ref().update({
      [`rooms/${strictRoomId}/tickets/stage-001`]: null,
      [`rooms/${strictRoomId}/ticketPresence/stage-001`]: null,
      [`rooms/${strictRoomId}/publicTicketPresence/stage-001`]: null,
    }));

    await assertFails(bob.ref(`rooms/${privacyRoomId}/publicPlayers/${aliceProfileId}`).update({
      name: "Forged Alice",
    }));
    await assertFails(bob.ref(`rooms/${privacyRoomId}/publicProfileOwners/${aliceProfileId}`).set("bob"));
    await assertFails(privacyHost.ref(`rooms/${privacyRoomId}/publicResults/privacy-stage`).update({
      uuid: "raw-uid-must-not-be-public",
    }));
    await assertSucceeds(privacyHost.ref(`rooms/${privacyRoomId}/publicScores/${aliceProfileId}`).update({
      total: 11,
    }));

    const forbiddenPublicFields = {
      uuid: "alice",
      ticket: { boardFloor: 1 },
      prediction: "bob",
      predictions: ["bob"],
      breakdown: [{ score: 1 }],
      predictionBreakdown: [{ score: 1 }],
      eventBreakdown: [{ score: 1 }],
      stageSkill: 40,
      stageSkillHistory: [40],
      history: [40],
      unknownField: true,
    };
    for (const [field, value] of Object.entries(forbiddenPublicFields)) {
      await assertFails(privacyHost.ref(`rooms/${privacyRoomId}/public`).set(Object.assign(publicNode({
        gameId: "privacy-game",
        phase: "countdown",
        roomVersion: 5,
        currentStageId: "privacy-stage",
        playerCount: 2,
        submittedCount: 1,
      }), { [field]: value })));

      const summaryId = `leak-summary-${field}`;
      await assertFails(privacyHost.ref(`rooms/${privacyRoomId}/completedGameSummaries/${summaryId}`).set(
        Object.assign(completedGameSummary(summaryId), { [field]: value })
      ));

      const detailId = `leak-detail-${field}`;
      const detail = completedGamePublicDetail(detailId);
      detail.stageResults["stage-001"] = Object.assign({}, detail.stageResults["stage-001"], {
        [field]: value,
      });
      await assertFails(privacyHost.ref(`rooms/${privacyRoomId}/completedGamePublicDetails/${detailId}`).set(detail));
    }
    await assertFails(privacyHost.ref(`rooms/${privacyRoomId}/public`).set(publicNode({
      gameId: "privacy-game",
      phase: "countdown",
      roomVersion: 5,
      currentStageId: "privacy-stage",
      playerCount: "2",
    })));
    await assertFails(privacyHost.ref(`rooms/${privacyRoomId}/completedGameSummaries/raw-ranking`).set(
      completedGameSummary("raw-ranking", {
        rankings: [Object.assign(publicHistoryRanking(), { uuid: "alice" })],
      })
    ));
    await assertFails(privacyHost.ref(`rooms/${privacyRoomId}/completedGameSummaries/scalar-ranking`).set(
      completedGameSummary("scalar-ranking", { rankings: "uuid=alice" })
    ));
    await assertFails(privacyHost.ref(`rooms/${privacyRoomId}/completedGamePublicDetails/scalar-stages`).set(
      completedGamePublicDetail("scalar-stages", { stageResults: "ticket=secret" })
    ));
    await assertFails(privacyHost.ref(`rooms/${privacyRoomId}/completedGamePublicDetails/wrong-stage-key`).set(
      completedGamePublicDetail("wrong-stage-key", {
        stageResults: {
          "stage-001": {
            stageId: "different-stage",
            stageName: "Stage 1",
            calculatedAt: "2026-07-29T00:00:04.000Z",
            participantCount: 1,
            rankings: [publicHistoryRanking()],
          },
        },
      })
    ));

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
        schemaVersion: "firebase-rtdb-v4-public-projection",
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
      [`rooms/${productionRoomId}/players/missing-root/profileId`]: missingRootProfileId,
      [`rooms/${productionRoomId}/publicConfig`]: {
        schemaVersion: "1.0.0",
        gameMeta: { title: "Production rules test" },
        stages: [{
          stageId: "stage-001",
          name: "Stage 1",
          params: { N: 3, X: 2, P: 10, Q: 1 },
        }],
      },
      [`rooms/${productionRoomId}/publicPlayers/${missingRootProfileId}`]: {
        profileId: missingRootProfileId,
        name: "Missing Root",
        connected: true,
        order: 0,
      },
      [`rooms/${productionRoomId}/publicProfileOwners/${missingRootProfileId}`]: "missing-root",
      [`rooms/${productionRoomId}/historyPlayers/p_missing_root`]: {
        profileId: "p_missing_root",
        name: "Missing Root",
        currentSkill: 70,
        updatedAt: "2026-07-29T00:00:05.000Z",
      },
      [`rooms/${productionRoomId}/operations/backfill`]: {
        at: "2026-07-29T00:00:05.000Z",
        actor: "host",
        action: "firebase-backfill-public-projection",
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
      [`rooms/${roomId}/completedGameSummaries/game-1`]: completedGameSummary("game-1", {
        title: "Rules test",
        finishedAt: "2026-07-29T00:00:05.000Z",
      }),
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
      [`rooms/${roomId}/completedGameSummaries/game-1`]: completedGameSummary("game-1", {
        title: "Rules test repaired",
        finishedAt: "2026-07-29T00:00:05.000Z",
        stageCount: 2,
        stages: [
          { stageId: "stage-001", name: "Stage 1" },
          { stageId: "stage-002", name: "Stage 2" },
        ],
      }),
      [`rooms/${roomId}/completedGamePublicDetails/game-1`]: completedGamePublicDetail("game-1", {
        title: "Rules test repaired",
        stageResults: {
          "stage-001": {
            stageId: "stage-001",
            stageName: "Stage 1",
            calculatedAt: "2026-07-29T00:00:04.000Z",
            participantCount: 0,
            rankings: [],
          },
          "stage-002": {
            stageId: "stage-002",
            stageName: "Stage 2",
            calculatedAt: "2026-07-29T00:00:05.000Z",
            participantCount: 0,
            rankings: [],
          },
        },
      }),
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
      summary: completedGameSummary("game-2", {
        title: "Rules second game",
        finishedAt: "2026-07-29T00:00:07.000Z",
      }),
      publicDetail: completedGamePublicDetail("game-2", {
        title: "Rules second game",
        finishedAt: "2026-07-29T00:00:07.000Z",
        stageResults: {
          "stage-001": {
            stageId: "stage-001",
            stageName: "Stage 1",
            calculatedAt: "2026-07-29T00:00:06.000Z",
            participantCount: 0,
            rankings: [],
          },
        },
      }),
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

    await assertSucceeds(host.ref(`rooms/${roomId}/completedGamePublicDetails/game-0`).set(completedGamePublicDetail("game-0", {
      rankings: [{ profileId: "p_alice", name: "Alice", rank: 1, score: 20 }],
      stageResults: {
        "stage-001": {
          stageId: "stage-001",
          stageName: "Stage 1",
          calculatedAt: "2026-07-29T00:00:04.000Z",
          participantCount: 1,
          rankings: [{ profileId: "p_alice", name: "Alice", rank: 1, score: 20 }],
        },
      },
    })));
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
