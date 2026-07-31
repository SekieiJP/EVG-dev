const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const configSource = fs
  .readFileSync(path.join(__dirname, "../../game/assets/js/config.js"), "utf8")
  .replace("FIREBASE_USE_LOCAL_MOCK: false", "FIREBASE_USE_LOCAL_MOCK: true");

async function openRole(context, role, slot) {
  const page = await context.newPage();
  await page.goto(`/game/index.html?view=${role}&testSlot=${slot}`);
  await expect(page.locator("body")).toHaveAttribute("data-role", role);
  return page;
}

async function publishMockRoom(page, mutate) {
  await page.evaluate((source) => {
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
  }, mutate);
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
