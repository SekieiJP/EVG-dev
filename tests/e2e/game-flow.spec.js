const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const configSource = fs
  .readFileSync(path.join(__dirname, "../../game/assets/js/config.js"), "utf8")
  .replace("FIREBASE_USE_LOCAL_MOCK: false", "FIREBASE_USE_LOCAL_MOCK: true");

const EMPTY_LOBBY_HISTORY_GAME_ID = "history-empty-lobby-game";
const EMPTY_LOBBY_CURRENT_GAME_ID = "history-empty-lobby-current";

async function openRole(context, role, slot) {
  const page = await context.newPage();
  const query = new URLSearchParams({
    view: role,
    testSlot: slot,
    backend: "firebase-mock",
  });
  await page.goto(`/game/index.html?${query.toString()}`);
  await expect(page.locator("body")).toHaveAttribute("data-role", role);
  return page;
}

async function publishMockRoom(page, mutate) {
  await page.evaluate(({ source, historyGameId, currentGameId }) => {
    const db = JSON.parse(localStorage.getItem("evg.firebase.mock.db.v1") || "{}");
    const room = db.rooms && db.rooms["elevator-game-live"];
    if (!room) throw new Error("mock room is not initialized");
    // The test passes a deliberately small operation name instead of source
    // code. This keeps page evaluation deterministic and CSP-safe.
    if (source === "one-stage") {
      room.config.stages = room.config.stages.slice(0, 1);
    } else if (source === "unicode-game-id") {
      room.public.gameId = "日本語ゲーム-20260731";
      room.meta.activeGameId = room.public.gameId;
    } else if (source === "expire-moving") {
      room.public.countdownEndsAt = new Date(Date.now() - 5_000).toISOString();
      room.public.tallyingEndsAt = new Date(Date.now() - 1_000).toISOString();
    } else if (source === "finish-reveal") {
      room.public.animationStartedAt = new Date(Date.now() - 120_000).toISOString();
      room.public.revealEndsAt = new Date(Date.now() - 1_000).toISOString();
    } else if (source === "history-fixture") {
      const gameId = room.public.gameId;
      const result = room.results && room.results["stage-001"];
      const finishedAt = new Date().toISOString();
      const detail = {
        gameId,
        title: "日本語ゲーム",
        finishedAt,
        rankings: result && result.rankings || [],
        stageResults: room.results || {},
      };
      room.completedGameSummaries = {
        [gameId]: {
          gameId,
          title: detail.title,
          finishedAt,
          stageCount: 1,
          rankings: detail.rankings,
        },
      };
      room.completedGameDetails = { [gameId]: detail };
      room.completedGamePublicDetails = { [gameId]: detail };
      room.historyPlayers = Object.entries(room.players || {}).reduce((players, [uid, player]) => {
        const profileId = window.EVGFirebaseAdapter.publicProfileId(uid);
        players[profileId] = {
          profileId,
          name: player.name,
          currentSkill: Number(room.playerStats && room.playerStats[uid] && room.playerStats[uid].currentSkill || 0),
          updatedAt: finishedAt,
        };
        return players;
      }, {});
      room.playerStats = {};
    } else if (source === "history-empty-lobby-fixture") {
      const finishedAt = "2026-07-30T03:00:00.000Z";
      const stageId = "history-stage-001";
      const participants = [
        { uid: "history-alice", name: "History Alice", score: 30, stageSkill: 42, currentSkill: 72 },
        { uid: "history-bob", name: "History Bob", score: 20, stageSkill: 35, currentSkill: 61 },
      ];
      const rankings = participants.map((player, index) => ({
        uuid: player.uid,
        name: player.name,
        rank: index + 1,
        score: player.score,
        currentSkill: player.currentSkill,
      }));
      const publicRankings = rankings.map((row) => ({
        profileId: window.EVGFirebaseAdapter.publicProfileId(row.uuid),
        name: row.name,
        rank: row.rank,
        score: row.score,
      }));
      const stagePlayers = participants.reduce((players, player) => {
        players[player.uid] = {
          uuid: player.uid,
          name: player.name,
          score: player.score,
          stageSkill: player.stageSkill,
        };
        return players;
      }, {});
      const scores = participants.reduce((values, player) => {
        values[player.uid] = player.score;
        return values;
      }, {});
      const detail = {
        gameId: historyGameId,
        title: "空ロビー前の保存済みゲーム",
        finishedAt,
        interrupted: false,
        finalPhase: "final",
        scores,
        rankings,
        stageResults: {
          [stageId]: {
            stageId,
            stageName: "保存済みステージ",
            calculatedAt: finishedAt,
            rankings,
            players: stagePlayers,
          },
        },
        playerSnapshots: participants.map((player) => ({
          uuid: player.uid,
          name: player.name,
          skill: player.currentSkill,
          stageSkillHistory: [player.stageSkill, player.currentSkill - player.stageSkill],
        })),
      };
      room.completedGameSummaries = {
        [historyGameId]: {
          gameId: historyGameId,
          title: detail.title,
          finishedAt,
          interrupted: false,
          finalPhase: "final",
          stageCount: 1,
          playerCount: participants.length,
          rankings: publicRankings,
          stages: [{ stageId, name: "保存済みステージ" }],
        },
      };
      room.completedGameDetails = { [historyGameId]: detail };
      room.completedGamePublicDetails = {
        [historyGameId]: {
          gameId: historyGameId,
          title: detail.title,
          finishedAt,
          interrupted: false,
          finalPhase: "final",
          rankings: publicRankings,
          stageResults: {
            [stageId]: {
              stageId,
              stageName: "保存済みステージ",
              calculatedAt: finishedAt,
              participantCount: participants.length,
              rankings: publicRankings,
            },
          },
        },
      };
      room.completedGamePlayerDetails = participants.reduce((details, player) => {
        details[player.uid] = {
          [historyGameId]: {
            gameId: historyGameId,
            title: detail.title,
            finishedAt,
            scores: { [player.uid]: player.score },
            rankings: publicRankings,
            stageResults: {
              [stageId]: {
                stageId,
                rankings: publicRankings,
                players: { [player.uid]: stagePlayers[player.uid] },
              },
            },
          },
        };
        return details;
      }, {});
      room.historyPlayers = participants.reduce((players, player) => {
        const profileId = window.EVGFirebaseAdapter.publicProfileId(player.uid);
        players[profileId] = {
          profileId,
          name: player.name,
          currentSkill: player.currentSkill,
          updatedAt: finishedAt,
        };
        return players;
      }, {});
      delete room.players;
      delete room.playerStats;
      delete room.tickets;
      delete room.ticketPresence;
      delete room.results;
      delete room.scores;
      room.archive = null;
      room.public = Object.assign({}, room.public || {}, {
        gameId: currentGameId,
        phase: "lobby",
        roomVersion: Number(room.public && room.public.roomVersion || 0) + 1,
        currentStageIndex: 0,
        currentStageId: room.config && room.config.stages && room.config.stages[0]
          ? room.config.stages[0].stageId
          : "stage-001",
        playerCount: 0,
        submittedCount: 0,
        abstainedCount: 0,
        countdownEndsAt: null,
        tallyingEndsAt: null,
        animationStartedAt: null,
        animationSkippedAt: null,
        revealEndsAt: null,
      });
      room.meta = Object.assign({}, room.meta || {}, {
        activeGameId: currentGameId,
        status: "active",
        updatedAt: new Date().toISOString(),
      });
    } else if (source === "bob-ticket") {
      const playerEntry = Object.entries(room.players || {}).find(([, player]) => player.name === "Bob");
      if (!playerEntry) throw new Error("Bob is not registered");
      const uid = playerEntry[0];
      room.tickets["stage-001"] = room.tickets["stage-001"] || {};
      room.tickets["stage-001"][uid] = {
        uuid: uid,
        boardFloor: 1,
        exitFloor: 4,
        predictions: {},
        abstained: false,
        submittedAt: new Date().toISOString(),
      };
      room.ticketPresence = room.ticketPresence || {};
      room.ticketPresence["stage-001"] = room.ticketPresence["stage-001"] || {};
      room.ticketPresence["stage-001"][uid] = { status: "submitted", updatedAt: new Date().toISOString() };
    }
    localStorage.setItem("evg.firebase.mock.db.v1", JSON.stringify(db));
    const channel = new BroadcastChannel("evg.firebase.mock.channel.v1");
    channel.postMessage({ type: "room", roomId: "elevator-game-live", version: room.public.roomVersion || 0 });
    channel.close();
  }, {
    source: mutate,
    historyGameId: EMPTY_LOBBY_HISTORY_GAME_ID,
    currentGameId: EMPTY_LOBBY_CURRENT_GAME_ID,
  });
}

async function mockHistoryKeys(page) {
  return page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("evg.firebase.mock.db.v1") || "{}");
    const room = db.rooms && db.rooms["elevator-game-live"];
    if (!room) throw new Error("mock room is not initialized");
    const playerDetails = Object.entries(room.completedGamePlayerDetails || {}).flatMap(([uid, games]) => {
      return Object.keys(games || {}).map((gameId) => `${uid}/${gameId}`);
    });
    return {
      summaries: Object.keys(room.completedGameSummaries || {}).sort(),
      publicDetails: Object.keys(room.completedGamePublicDetails || {}).sort(),
      hostDetails: Object.keys(room.completedGameDetails || {}).sort(),
      playerDetails: playerDetails.sort(),
      historyPlayers: Object.keys(room.historyPlayers || {}).sort(),
    };
  });
}

async function waitForMockGameId(page, previousGameId) {
  await expect.poll(() => page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("evg.firebase.mock.db.v1") || "{}");
    return db.rooms && db.rooms["elevator-game-live"] && db.rooms["elevator-game-live"].public.gameId;
  })).not.toBe(previousGameId);
}

test("Host・Player 2人・Screenが同じステージ結果とSkill更新へ追従する", async ({ browser }) => {
  const context = await browser.newContext();
  await context.route(/\/game\/assets\/js\/config\.js(?:\?.*)?$/, (route) => {
    return route.fulfill({ status: 200, contentType: "application/javascript", body: configSource });
  });

  const host = await openRole(context, "host", "host");
  await host.locator("#hostAuthForm input[name=password]").fill("host");
  await host.locator("#hostAuthForm button[type=submit]").click();
  await expect(host.locator(".host-shell")).toBeVisible();
  const countdownInput = host.locator('#hostRoomSettingsForm input[name="countdownSeconds"]');
  await expect(countdownInput).toHaveValue("10");
  await countdownInput.fill("12");
  await host.locator("#hostRoomSettingsForm").evaluate((form) => form.requestSubmit());
  await expect(countdownInput).toHaveValue("12");
  const persistedCountdownSeconds = await host.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("evg.firebase.mock.db.v1") || "{}");
    return db.rooms["elevator-game-live"].roomSettings.countdownSeconds;
  });
  expect(persistedCountdownSeconds).toBe(12);
  await publishMockRoom(host, "one-stage");
  await publishMockRoom(host, "unicode-game-id");

  const alice = await openRole(context, "player", "alice");
  await alice.locator("#joinForm input[name=name]").fill("Alice");
  await alice.locator("#joinForm button[type=submit]").click();
  await expect(alice.getByRole("heading", { name: "Alice" })).toBeVisible();

  const bob = await openRole(context, "player", "bob");
  await bob.locator("#joinForm input[name=name]").fill("Bob");
  await bob.locator("#joinForm button[type=submit]").click();
  await expect(bob.getByRole("heading", { name: "Bob" })).toBeVisible();

  const screen = await openRole(context, "screen", "screen");
  await screen.locator('[data-action="screen-ready"]').click();

  await expect(host.locator('[data-host-action="start-stage"]')).toBeEnabled();
  await host.locator('[data-host-action="start-stage"]').click();
  await expect(host.locator('[data-host-action="open-voting"]')).toBeEnabled();
  await host.locator('[data-host-action="open-voting"]').click();

  await expect(alice.locator("#ticketForm")).toBeVisible();
  await alice.locator('#ticketForm input[name="boardFloor"]').fill("1");
  await alice.locator('#ticketForm input[name="exitFloor"]').fill("3");
  await alice.locator("#ticketForm").evaluate((form) => form.requestSubmit());
  await expect(alice.locator('#ticketForm input[name="exitFloor"]')).toHaveValue("3");
  await publishMockRoom(host, "bob-ticket");
  await expect(bob.locator('#ticketForm input[name="exitFloor"]')).toHaveValue("4");
  await expect(host.getByText("1→3")).toBeVisible();
  await expect(host.getByText("1→4")).toBeVisible();

  await host.locator('[data-host-action="close-voting"]').click();
  await publishMockRoom(host, "expire-moving");
  await expect(host.locator("body")).toHaveAttribute("data-phase", "reveal");

  await publishMockRoom(host, "finish-reveal");
  for (const page of [alice, bob]) {
    await expect(page.getByText("スコア", { exact: true })).toBeVisible();
    await expect(page.getByText("StageSkill", { exact: true })).toBeVisible();
    await expect(page.locator(".stat-strip")).toContainText("持ち点");
    await expect(page.locator(".stat-strip")).toContainText("現在Skill");
  }
  await expect(screen.locator("body")).toHaveAttribute("data-phase", "reveal");
  const screenScores = screen.getByLabel("現在の得点");
  await expect(screenScores.getByText("Alice", { exact: true })).toBeVisible();
  await expect(screenScores.getByText("Bob", { exact: true })).toBeVisible();

  await host.locator('[data-host-action="show-ranking"]').click();
  await host.locator('[data-host-action="next-stage"]').click();
  await expect(host.locator("body")).toHaveAttribute("data-phase", "final");
  await expect(alice.locator("body")).toHaveAttribute("data-phase", "final");
  await expect(bob.locator("body")).toHaveAttribute("data-phase", "final");

  await publishMockRoom(host, "history-fixture");
  await host.getByRole("button", { name: "History", exact: true }).click();
  await expect(host.locator("body")).toHaveAttribute("data-role", "history");
  const historyGameButtons = host.locator('[data-action="select-history-game"]');
  await expect(historyGameButtons).toHaveCount(1);
  await historyGameButtons.click();
  await expect(host.locator(".history-stage-result .mini-row")).toHaveCount(2);
  await expect(host.locator("[data-history-player-id]")).toHaveCount(2);
  await expect(host.locator('[data-history-player-id]:has-text("Skill 0.00")')).toHaveCount(0);

  await context.close();
});

test("mock UI: 履歴あり空ロビーのJSON Import後もfresh Historyに旧履歴を表示する（本番writer/GASは対象外）", async ({ browser }) => {
  const context = await browser.newContext();
  await context.route(/\/game\/assets\/js\/config\.js(?:\?.*)?$/, (route) => {
    return route.fulfill({ status: 200, contentType: "application/javascript", body: configSource });
  });

  const host = await openRole(context, "host", "empty-history-host");
  await host.locator("#hostAuthForm input[name=password]").fill("host");
  await host.locator("#hostAuthForm button[type=submit]").click();
  await expect(host.locator(".host-shell")).toBeVisible();

  // This fixture exercises the UI, Engine transition and mock serialization only.
  // The production RTDB multi-location writer, Rules and GAS archive are covered separately.
  await publishMockRoom(host, "history-empty-lobby-fixture");
  await expect(host.locator("#internal-status")).toContainText(EMPTY_LOBBY_CURRENT_GAME_ID);
  const historyBeforeImport = await mockHistoryKeys(host);

  await host.locator('[data-action="import-config"]').click();
  await waitForMockGameId(host, EMPTY_LOBBY_CURRENT_GAME_ID);
  await expect(host.locator(".loading-overlay")).toBeHidden();
  expect(await mockHistoryKeys(host)).toEqual(historyBeforeImport);

  await host.reload();
  await expect(host.locator(".host-shell")).toBeVisible();
  expect(await mockHistoryKeys(host)).toEqual(historyBeforeImport);

  const history = await openRole(context, "history", "fresh-history-after-import");
  const oldGame = history.locator(
    `[data-action="select-history-game"][data-game-id="${EMPTY_LOBBY_HISTORY_GAME_ID}"]`
  );
  await expect(oldGame).toHaveCount(1);
  await oldGame.click();
  await expect(history.locator(".history-stage-result")).toHaveCount(1);
  await expect(history.locator(".history-stage-result")).toContainText("保存済みステージ");
  await expect(history.locator(".history-stage-result .mini-row")).toHaveCount(2);
  await expect(history.locator("[data-history-player-id]")).toHaveCount(2);
  await expect(history.locator('[data-history-player-id]:has-text("Skill 0.00")')).toHaveCount(0);

  await context.close();
});

test("mock UI: 同期2clickをbusy guardで1回に抑え履歴キーを保持する（本番RTDB CASは対象外）", async ({ browser }) => {
  const context = await browser.newContext();
  await context.route(/\/game\/assets\/js\/config\.js(?:\?.*)?$/, (route) => {
    return route.fulfill({ status: 200, contentType: "application/javascript", body: configSource });
  });

  const host = await openRole(context, "host", "double-import-host");
  await host.locator("#hostAuthForm input[name=password]").fill("host");
  await host.locator("#hostAuthForm button[type=submit]").click();
  await expect(host.locator(".host-shell")).toBeVisible();
  await publishMockRoom(host, "history-empty-lobby-fixture");
  await expect(host.locator("#internal-status")).toContainText(EMPTY_LOBBY_CURRENT_GAME_ID);
  const historyBeforeClicks = await mockHistoryKeys(host);

  await host.evaluate(() => {
    const firstButton = document.querySelector('[data-action="import-config"]');
    if (!firstButton) throw new Error("first Import button is missing");
    firstButton.click();
    const secondButton = document.querySelector('[data-action="import-config"]');
    if (!secondButton) throw new Error("second Import button is missing");
    secondButton.click();
  });

  await waitForMockGameId(host, EMPTY_LOBBY_CURRENT_GAME_ID);
  await expect(host.locator(".loading-overlay")).toBeHidden();
  expect(await mockHistoryKeys(host)).toEqual(historyBeforeClicks);
  const importResponses = await host.evaluate(() => {
    const logs = JSON.parse(localStorage.getItem("evg.logs.v1") || "[]");
    return logs.filter((entry) => {
      if (!entry || !["api.response", "api.response.error"].includes(entry.kind)) return false;
      try {
        return JSON.parse(entry.message || "{}").path === "/api/host/import-config";
      } catch (_error) {
        return false;
      }
    }).length;
  });
  expect(importResponses).toBe(1);

  await host.reload();
  await expect(host.locator(".host-shell")).toBeVisible();
  expect(await mockHistoryKeys(host)).toEqual(historyBeforeClicks);

  await context.close();
});
