(() => {
  const Engine = window.ElevatorGameEngine;
  const STORAGE_KEYS = {
    room: "evg.room.v1",
    playerUuid: "evg.playerUuid.v1",
    hostAuthed: "evg.hostAuthed.v1",
    logs: "evg.logs.v1",
    screenReady: "evg.screenReady.v1",
  };
  const state = {
    role: new URLSearchParams(location.search).get("view") || "player",
    room: null,
    playerUuid: localStorage.getItem(STORAGE_KEYS.playerUuid) || "",
    hostAuthed: localStorage.getItem(STORAGE_KEYS.hostAuthed) === "true",
    screenReady: localStorage.getItem(STORAGE_KEYS.screenReady) === "true",
    logs: loadJson(STORAGE_KEYS.logs, []),
    toast: "",
    selectedHistoryUuid: "",
  };

  const $ = (selector) => document.querySelector(selector);

  document.addEventListener("DOMContentLoaded", () => {
    state.room = loadRoom();
    bindGlobalEvents();
    render();
    setInterval(tick, 1000);
    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEYS.room) {
        state.room = loadRoom();
        render();
      }
    });
  });

  function bindGlobalEvents() {
    $("#roleTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-role]");
      if (!button) return;
      state.role = button.dataset.role;
      history.replaceState(null, "", `?view=${state.role}`);
      render();
    });
    $("#app").addEventListener("submit", handleSubmit);
    $("#app").addEventListener("click", handleClick);
    $("#app").addEventListener("change", handleChange);
    $("#app").addEventListener("input", handleInput);
  }

  function tick() {
    if (!state.room) return;
    let changed = false;
    if (state.room.phase === Engine.PHASES.COUNTDOWN && state.room.countdownEndsAt) {
      const remaining = new Date(state.room.countdownEndsAt).getTime() - Date.now();
      if (remaining <= 0) {
        const tallied = Engine.tallyCurrentStage(state.room);
        if (tallied.ok) {
          state.room = tallied.room;
          logClient("state", "締切後に自動集計しました。");
          saveRoom();
          changed = true;
        }
      }
    }
    if (changed || state.role === "screen" || state.role === "player") render();
  }

  function handleSubmit(event) {
    event.preventDefault();
    const form = event.target;
    if (form.id === "joinForm") {
      const name = form.elements.name.value;
      const carryUuid = form.elements.restoreUuid.value.trim() || state.playerUuid;
      const result = Engine.registerPlayer(state.room, name, carryUuid || undefined);
      if (!result.ok) return showToast(result.error);
      state.room = result.room;
      state.playerUuid = result.player.uuid;
      localStorage.setItem(STORAGE_KEYS.playerUuid, state.playerUuid);
      saveRoom("join", result.player.uuid);
      showToast("参加しました。");
      render();
    }
    if (form.id === "ticketForm") {
      const stage = Engine.getCurrentStage(state.room);
      const predictions = {};
      Engine.getPredictionEvents(stage).forEach((_, index) => {
        predictions[index] = form.elements[`prediction_${index}`]
          ? form.elements[`prediction_${index}`].value
          : "";
      });
      const ticket = {
        boardFloor: Number(form.elements.boardFloor.value),
        exitFloor: Number(form.elements.exitFloor.value),
        predictions,
      };
      const warnings = Engine.warningsForTicket(stage, ticket);
      if (warnings.length && !confirm(`${warnings.join("\n")}\n\n送信しますか？`)) return;
      const result = Engine.submitTicket(state.room, state.playerUuid, ticket);
      if (!result.ok) return showToast(result.error);
      state.room = result.room;
      saveRoom("ticket.submit", state.playerUuid);
      showToast("チケットを更新しました。");
      render();
    }
    if (form.id === "hostAuthForm") {
      const password = form.elements.password.value;
      const configured = getHostPassword(state.room);
      if (password !== configured) return showToast("パスワードが違います。");
      state.hostAuthed = true;
      localStorage.setItem(STORAGE_KEYS.hostAuthed, "true");
      render();
    }
    if (form.id === "renameForm") {
      const result = Engine.renamePlayer(state.room, state.playerUuid, form.elements.nextName.value);
      if (!result.ok) return showToast(result.error);
      state.room = result.room;
      saveRoom("player.rename", state.playerUuid);
      showToast(result.player.pendingName ? "次ステージから反映します。" : "名前を変更しました。");
      render();
    }
    if (form.id === "uuidImportForm") {
      const uuid = form.elements.importUuid.value.trim();
      if (!uuid) return showToast("UUIDを入力してください。");
      state.playerUuid = uuid;
      localStorage.setItem(STORAGE_KEYS.playerUuid, uuid);
      showToast("UUIDを設定しました。");
      render();
    }
  }

  function handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (button.disabled) return;
    if (action === "host-action") {
      const result = Engine.advancePhase(state.room, button.dataset.hostAction, "host");
      if (!result.ok) return showToast(result.error || "操作できません。");
      state.room = result.room;
      saveRoom(`host.${button.dataset.hostAction}`, "host");
      render();
    }
    if (action === "abstain") {
      const result = Engine.abstain(state.room, state.playerUuid);
      if (!result.ok) return showToast(result.error);
      state.room = result.room;
      saveRoom("ticket.abstain", state.playerUuid);
      showToast("棄権を送信しました。");
      render();
    }
    if (action === "player-next") {
      if (state.room.phase !== Engine.PHASES.RANKING) return showToast("ホストの操作待ちです。");
      const result = Engine.advancePhase(state.room, "next-stage", "player");
      if (!result.ok) return showToast(result.error || "進行できません。");
      state.room = result.room;
      saveRoom("player.proceed-next", state.playerUuid);
      render();
    }
    if (action === "screen-ready") {
      state.screenReady = true;
      localStorage.setItem(STORAGE_KEYS.screenReady, "true");
      startAudioContext();
      render();
    }
    if (action === "copy-uuid") {
      navigator.clipboard && navigator.clipboard.writeText(state.playerUuid);
      showToast("UUIDをコピーしました。");
    }
    if (action === "export-config") {
      downloadJson("elevator-game-config.json", state.room.config);
    }
    if (action === "import-config") {
      const textarea = $("#configJson");
      try {
        const config = Engine.normalizeConfig(JSON.parse(textarea.value));
        state.room = Engine.createInitialRoom(config);
        saveRoom("host.config.import", "host");
        showToast("設定を読み込みました。");
        render();
      } catch (error) {
        showToast(`JSONを読み込めません: ${error.message}`);
      }
    }
    if (action === "import-stage") {
      const textarea = $("#stageJson");
      try {
        const stage = JSON.parse(textarea.value);
        const next = Engine.deepClone(state.room);
        next.config.stages.push(Engine.normalizeConfig({ stages: [stage] }).stages[0]);
        state.room = next;
        saveRoom("host.stage.import", "host");
        showToast("ステージを追加しました。");
        render();
      } catch (error) {
        showToast(`JSONを読み込めません: ${error.message}`);
      }
    }
    if (action === "reset-local") {
      if (!confirm("ローカルの進行中データをリセットしますか？")) return;
      state.room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
      saveRoom("local.reset", "host");
      render();
    }
    if (action === "select-history") {
      state.selectedHistoryUuid = button.dataset.uuid;
      render();
    }
  }

  function handleChange(event) {
    if (event.target.id === "muteToggle") {
      state.room.muted = event.target.checked;
      saveRoom("screen.mute", "host");
      render();
    }
  }

  function handleInput(event) {
    if (event.target.id === "volumeRange") {
      state.room.volume = Number(event.target.value);
      saveRoom("screen.volume", "host");
    }
  }

  function render() {
    const app = $("#app");
    document.body.dataset.phase = state.room.phase;
    document.body.dataset.role = state.role;
    [...document.querySelectorAll("[data-role]")].forEach((button) => {
      button.classList.toggle("is-active", button.dataset.role === state.role);
    });
    const views = {
      player: renderPlayerView,
      host: renderHostView,
      screen: renderScreenView,
      history: renderHistoryView,
      settings: renderSettingsView,
    };
    app.innerHTML = `
      ${state.toast ? `<div class="toast" role="status">${escapeHtml(state.toast)}</div>` : ""}
      ${views[state.role] ? views[state.role]() : renderPlayerView()}
    `;
  }

  function renderPlayerView() {
    const player = getCurrentPlayer();
    if (!player) return renderJoin();
    const stage = Engine.getCurrentStage(state.room);
    const ticket = getStageTickets()[state.playerUuid];
    const result = getCurrentStageResult();
    return `
      <section class="shell player-shell">
        <header class="view-header">
          <div>
            <p class="eyebrow">Player</p>
            <h1>${escapeHtml(player.name)}</h1>
          </div>
          <div class="stat-strip">
            <span>合計 ${formatNumber(state.room.scores[player.uuid] || 0)}</span>
            <span>Skill ${formatNumber(player.skill || 0)}</span>
          </div>
        </header>
        ${renderPhaseBanner()}
        ${stage ? renderStageSummary(stage) : ""}
        ${renderPlayerBody(stage, ticket, result)}
      </section>
    `;
  }

  function renderJoin() {
    return `
      <section class="shell narrow">
        <header class="view-header">
          <div>
            <p class="eyebrow">Entry</p>
            <h1>参加登録</h1>
          </div>
        </header>
        <form id="joinForm" class="panel form-grid">
          <label>名前<input name="name" maxlength="24" autocomplete="name" required></label>
          <label>UUID<input name="restoreUuid" value="${escapeAttr(state.playerUuid)}" autocomplete="off"></label>
          <button class="primary" type="submit">参加</button>
        </form>
      </section>
    `;
  }

  function renderPlayerBody(stage, ticket, result) {
    if (!stage) return `<div class="panel">ステージがありません。</div>`;
    if ([Engine.PHASES.VOTING, Engine.PHASES.COUNTDOWN].includes(state.room.phase)) {
      return renderTicketForm(stage, ticket);
    }
    if ([Engine.PHASES.REVEAL, Engine.PHASES.RANKING, Engine.PHASES.FINAL].includes(state.room.phase)) {
      return renderPlayerResult(result);
    }
    return `
      <div class="panel split">
        <div>
          <h2>チケット</h2>
          <p class="muted">${ticket ? `${ticket.boardFloor}階 → ${ticket.exitFloor}階` : "未購入"}</p>
        </div>
        <button data-action="player-next" ${state.room.phase === Engine.PHASES.RANKING ? "" : "disabled"}>次へ</button>
      </div>
    `;
  }

  function renderTicketForm(stage, ticket) {
    const predictionEvents = Engine.getPredictionEvents(stage);
    return `
      <form id="ticketForm" class="panel ticket-grid">
        <label>乗車階
          <input name="boardFloor" type="number" min="1" max="${stage.params.N}" value="${ticket ? ticket.boardFloor : 1}" required>
        </label>
        <label>降車階
          <input name="exitFloor" type="number" min="1" max="${stage.params.N}" value="${ticket ? ticket.exitFloor : stage.params.N}" required>
        </label>
        ${predictionEvents.map((event, index) => renderPredictionInput(event, index, ticket)).join("")}
        <div class="form-actions">
          <button class="primary" type="submit">購入</button>
          <button type="button" data-action="abstain">棄権</button>
        </div>
      </form>
    `;
  }

  function renderPredictionInput(event, index, ticket) {
    const value = ticket && ticket.predictions ? ticket.predictions[index] || "" : "";
    if (event.answerFormat === "yesno") {
      return `
        <label>${escapeHtml(event.question)}
          <select name="prediction_${index}">
            <option value=""></option>
            <option value="yes" ${value === "yes" ? "selected" : ""}>Yes</option>
            <option value="no" ${value === "no" ? "selected" : ""}>No</option>
          </select>
        </label>
      `;
    }
    if (event.answerFormat === "integer") {
      return `<label>${escapeHtml(event.question)}<input name="prediction_${index}" type="number" value="${escapeAttr(value)}"></label>`;
    }
    return `<label>${escapeHtml(event.question)}<input name="prediction_${index}" value="${escapeAttr(value)}"></label>`;
  }

  function renderPlayerResult(result) {
    const myResult = result && result.players ? result.players[state.playerUuid] : null;
    if (!myResult) return `<div class="panel">結果待ち</div>`;
    return `
      <div class="result-layout">
        <section class="panel score-card">
          <p class="eyebrow">Stage Score</p>
          <strong>${formatNumber(myResult.score)}</strong>
          <span>${statusLabel(myResult.status)}</span>
        </section>
        <section class="panel breakdown">
          <h2>内訳</h2>
          <dl>
            <div><dt>乗車成功点</dt><dd>${formatNumber(myResult.successPoint)}</dd></div>
            <div><dt>イベント補正</dt><dd>${formatNumber(myResult.eventBonus)}</dd></div>
            <div><dt>チケット代</dt><dd>-${formatNumber(myResult.penalty)}</dd></div>
            <div><dt>実上昇</dt><dd>${formatNumber(myResult.actualRise)}階</dd></div>
            <div><dt>StageSkill</dt><dd>${myResult.stageSkill === null ? "-" : formatNumber(myResult.stageSkill)}</dd></div>
          </dl>
        </section>
        <section class="panel">
          <h2>予想</h2>
          ${myResult.predictionBreakdown.length ? myResult.predictionBreakdown.map((item) => `
            <div class="mini-row">
              <span>${escapeHtml(item.question)}</span>
              <strong>${formatNumber(item.score)}</strong>
            </div>
          `).join("") : `<p class="muted">なし</p>`}
        </section>
        <button data-action="player-next" ${state.room.phase === Engine.PHASES.RANKING ? "" : "disabled"}>次へ</button>
      </div>
    `;
  }

  function renderHostView() {
    if (!state.hostAuthed) {
      return `
        <section class="shell narrow">
          <header class="view-header"><div><p class="eyebrow">Host</p><h1>認証</h1></div></header>
          <form id="hostAuthForm" class="panel form-grid">
            <label>パスワード<input name="password" type="password" required></label>
            <button class="primary" type="submit">認証</button>
          </form>
        </section>
      `;
    }
    const stage = Engine.getCurrentStage(state.room);
    return `
      <section class="shell host-shell">
        <header class="view-header">
          <div>
            <p class="eyebrow">Host</p>
            <h1>${escapeHtml(state.room.config.gameMeta.title)}</h1>
          </div>
          <div class="stat-strip">
            <span>${phaseLabel(state.room.phase)}</span>
            <span>${state.room.players.length}人</span>
          </div>
        </header>
        <div class="host-grid">
          <section class="panel">
            <h2>進行</h2>
            <div class="button-grid">
              ${hostButton("start-stage", "説明", state.room.phase === Engine.PHASES.LOBBY || state.room.phase === Engine.PHASES.RANKING)}
              ${hostButton("open-voting", "受付", state.room.phase === Engine.PHASES.STAGE_INTRO)}
              ${hostButton("close-voting", "締切", state.room.phase === Engine.PHASES.VOTING)}
              ${hostButton("tally", "集計", state.room.phase === Engine.PHASES.COUNTDOWN || state.room.phase === Engine.PHASES.TALLYING)}
              ${hostButton("show-ranking", "順位", state.room.phase === Engine.PHASES.REVEAL)}
              ${hostButton("skip-animation", "Skip", state.room.phase === Engine.PHASES.REVEAL)}
              ${hostButton("next-stage", "次", state.room.phase === Engine.PHASES.RANKING)}
            </div>
          </section>
          <section class="panel">
            <h2>音量</h2>
            <label class="inline"><input id="muteToggle" type="checkbox" ${state.room.muted ? "checked" : ""}>Mute</label>
            <input id="volumeRange" type="range" min="0" max="1" step="0.05" value="${state.room.volume}">
          </section>
          <section class="panel wide">
            <h2>現在ステージ</h2>
            ${stage ? renderStageSummary(stage) : ""}
          </section>
          <section class="panel wide">
            <h2>参加者</h2>
            ${renderParticipantsTable()}
          </section>
          <section class="panel wide">
            <h2>設定</h2>
            <div class="form-actions">
              <button type="button" data-action="export-config">Export</button>
              <button type="button" data-action="reset-local">Reset</button>
            </div>
            <textarea id="configJson" rows="8" spellcheck="false">${escapeHtml(JSON.stringify(state.room.config, null, 2))}</textarea>
            <button type="button" data-action="import-config">Import</button>
            <textarea id="stageJson" rows="5" spellcheck="false" placeholder="stage JSON"></textarea>
            <button type="button" data-action="import-stage">Stage Import</button>
          </section>
          <section class="panel">
            <h2>操作ログ</h2>
            <div class="log-list">${state.room.operations.map((item) => `<p>${formatTime(item.at)} ${escapeHtml(item.actor)} ${escapeHtml(item.action)}</p>`).join("") || `<p class="muted">なし</p>`}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderScreenView() {
    const stage = Engine.getCurrentStage(state.room);
    const result = getCurrentStageResult();
    return `
      <section class="screen-shell">
        ${!state.screenReady ? `<button class="ready-button" data-action="screen-ready">準備完了</button>` : ""}
        <div class="screen-top">
          <p>${escapeHtml(state.room.config.gameMeta.title)}</p>
          <span>${phaseLabel(state.room.phase)}</span>
        </div>
        ${renderScreenMain(stage, result)}
      </section>
    `;
  }

  function renderScreenMain(stage, result) {
    if (state.room.phase === Engine.PHASES.LOBBY) {
      return `
        <div class="screen-lobby">
          <h1>参加受付中</h1>
          <div class="join-url">${escapeHtml(location.origin + location.pathname + "?view=player")}</div>
          <div class="screen-players">${state.room.players.map((player) => `<span>${escapeHtml(player.name)}</span>`).join("")}</div>
        </div>
      `;
    }
    if (state.room.phase === Engine.PHASES.COUNTDOWN) {
      return `<div class="countdown-number">${countdownSeconds()}</div>`;
    }
    if (state.room.phase === Engine.PHASES.REVEAL && result) {
      return renderElevatorAnimation(stage, result);
    }
    if ([Engine.PHASES.RANKING, Engine.PHASES.FINAL].includes(state.room.phase)) {
      return renderRankingBoard();
    }
    return `
      <div class="screen-stage">
        <h1>${escapeHtml(stage.name)}</h1>
        ${renderStageSummary(stage)}
        <div class="progress-ring">${Object.keys(getStageTickets()).length}/${state.room.players.length}</div>
      </div>
    `;
  }

  function renderElevatorAnimation(stage, result) {
    const floors = Array.from({ length: stage.params.N }, (_, index) => stage.params.N - index);
    const forcedFloors = new Set(result.timeline.filter((step) => step.forcedOff.length).map((step) => step.floor));
    return `
      <div class="elevator-board">
        <div class="shaft">
          ${floors.map((floor) => `<div class="floor ${forcedFloors.has(floor) ? "danger" : ""}"><span>${floor}F</span></div>`).join("")}
          <div class="car" style="--floor-count:${stage.params.N}"></div>
        </div>
        <div class="screen-result-list">
          ${result.rankings.slice(0, 8).map((row) => `<div><span>${row.rank}. ${escapeHtml(row.name)}</span><strong>${formatNumber(row.score)}</strong></div>`).join("")}
        </div>
      </div>
    `;
  }

  function renderHistoryView() {
    const rankings = Engine.cumulativeRankings(state.room);
    const selectedUuid = state.selectedHistoryUuid || state.playerUuid || (rankings[0] && rankings[0].uuid);
    const selected = state.room.players.find((player) => player.uuid === selectedUuid);
    return `
      <section class="shell">
        <header class="view-header"><div><p class="eyebrow">History</p><h1>戦歴</h1></div></header>
        <div class="history-grid">
          <section class="panel">
            <h2>ランキング</h2>
            ${rankings.map((row) => `
              <button class="ranking-row" data-action="select-history" data-uuid="${escapeAttr(row.uuid)}">
                <span>${row.rank}. ${escapeHtml(row.name)}</span><strong>${formatNumber(row.score)}</strong>
              </button>
            `).join("") || `<p class="muted">なし</p>`}
          </section>
          <section class="panel">
            <h2>個人</h2>
            ${selected ? renderPlayerStats(selected) : `<p class="muted">なし</p>`}
          </section>
        </div>
      </section>
    `;
  }

  function renderSettingsView() {
    const player = getCurrentPlayer();
    return `
      <section class="shell">
        <header class="view-header"><div><p class="eyebrow">Settings</p><h1>設定</h1></div></header>
        <div class="settings-grid">
          <section class="panel">
            <h2>UUID</h2>
            <code class="uuid-box">${escapeHtml(state.playerUuid || "-")}</code>
            <button type="button" data-action="copy-uuid" ${state.playerUuid ? "" : "disabled"}>Copy</button>
            <form id="uuidImportForm" class="form-grid">
              <label>Import<input name="importUuid" value="${escapeAttr(state.playerUuid)}"></label>
              <button type="submit">Import</button>
            </form>
          </section>
          <section class="panel">
            <h2>名前</h2>
            <form id="renameForm" class="form-grid">
              <label>Name<input name="nextName" value="${escapeAttr(player ? player.pendingName || player.name : "")}"></label>
              <button type="submit" ${player ? "" : "disabled"}>Change</button>
            </form>
          </section>
          <section class="panel wide">
            <h2>通信ログ</h2>
            <div class="log-list">${state.logs.map((item) => `<p>${formatTime(item.at)} ${escapeHtml(item.kind)} ${escapeHtml(item.message)}</p>`).join("") || `<p class="muted">なし</p>`}</div>
          </section>
        </div>
      </section>
    `;
  }

  function renderStageSummary(stage) {
    return `
      <div class="stage-summary">
        <div><span>N</span><strong>${stage.params.N}</strong></div>
        <div><span>X</span><strong>${stage.params.X}</strong></div>
        <div><span>P</span><strong>${stage.params.P}</strong></div>
        <div><span>Q</span><strong>${stage.params.Q}</strong></div>
        <div class="event-list">
          ${(stage.events || []).map((event) => `<span>${eventLabel(event)}</span>`).join("") || `<span>イベントなし</span>`}
        </div>
      </div>
    `;
  }

  function renderPhaseBanner() {
    return `
      <div class="phase-banner">
        <span>${phaseLabel(state.room.phase)}</span>
        ${state.room.phase === Engine.PHASES.COUNTDOWN ? `<strong>${countdownSeconds()}秒</strong>` : ""}
      </div>
    `;
  }

  function renderParticipantsTable() {
    const tickets = getStageTickets();
    const rows = state.room.players.map((player) => {
      const ticket = tickets[player.uuid];
      return `
        <tr>
          <td>${escapeHtml(player.name)}${player.pendingName ? `<small>→${escapeHtml(player.pendingName)}</small>` : ""}</td>
          <td><code>${escapeHtml(player.uuid)}</code></td>
          <td>${ticket ? ticket.abstained ? "棄権" : `${ticket.boardFloor}→${ticket.exitFloor}` : "未投票"}</td>
          <td>${formatNumber(state.room.scores[player.uuid] || 0)}</td>
          <td>${formatNumber(player.skill || 0)}</td>
        </tr>
      `;
    });
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>名前</th><th>UUID</th><th>入力</th><th>得点</th><th>Skill</th></tr></thead>
          <tbody>${rows.join("") || `<tr><td colspan="5">なし</td></tr>`}</tbody>
        </table>
      </div>
    `;
  }

  function renderRankingBoard() {
    const rankings = Engine.cumulativeRankings(state.room);
    return `
      <div class="ranking-board">
        <h1>${state.room.phase === Engine.PHASES.FINAL ? "最終結果" : "中間ランキング"}</h1>
        ${rankings.map((row) => `
          <div class="screen-rank">
            <span>${row.rank}</span>
            <strong>${escapeHtml(row.name)}</strong>
            <em>${formatNumber(row.score)}</em>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderPlayerStats(player) {
    const stageResults = Object.values(state.room.stageResults || {})
      .map((stageResult) => stageResult.players[player.uuid])
      .filter(Boolean);
    const scores = stageResults.map((item) => item.score);
    const forced = stageResults.filter((item) => item.forcedOff).length;
    const answered = stageResults.flatMap((item) => item.predictionBreakdown || []).filter((item) => !item.noAnswer);
    const correct = answered.filter((item) => item.matched).length;
    return `
      <dl class="stats-list">
        <div><dt>現在Skill値</dt><dd>${formatNumber(player.skill || 0)}</dd></div>
        <div><dt>平均Skill値</dt><dd>${formatNumber(average(player.stageSkillHistory || []))}</dd></div>
        <div><dt>合計Skill値</dt><dd>${formatNumber((player.stageSkillHistory || []).reduce((a, b) => a + b, 0))}</dd></div>
        <div><dt>累積得点</dt><dd>${formatNumber(state.room.scores[player.uuid] || 0)}</dd></div>
        <div><dt>平均得点</dt><dd>${formatNumber(average(scores))}</dd></div>
        <div><dt>最高得点</dt><dd>${scores.length ? formatNumber(Math.max(...scores)) : "0.00"}</dd></div>
        <div><dt>参加ゲーム数</dt><dd>${stageResults.length ? 1 : 0}</dd></div>
        <div><dt>参加ステージ数</dt><dd>${stageResults.length}</dd></div>
        <div><dt>強制下車回数</dt><dd>${forced}</dd></div>
        <div><dt>予想イベント正解率</dt><dd>${answered.length ? formatNumber((correct / answered.length) * 100) + "%" : "-"}</dd></div>
        <div><dt>優勝回数</dt><dd>${isCurrentWinner(player.uuid) ? 1 : 0}</dd></div>
        <div><dt>表彰台回数</dt><dd>${isCurrentPodium(player.uuid) ? 1 : 0}</dd></div>
      </dl>
    `;
  }

  function hostButton(hostAction, label, enabled) {
    return `<button type="button" data-action="host-action" data-host-action="${hostAction}" ${enabled ? "" : "disabled"}>${label}</button>`;
  }

  function getCurrentPlayer() {
    return state.room.players.find((player) => player.uuid === state.playerUuid) || null;
  }

  function getStageTickets() {
    const stage = Engine.getCurrentStage(state.room);
    return stage ? state.room.tickets[stage.stageId] || {} : {};
  }

  function getCurrentStageResult() {
    const stage = Engine.getCurrentStage(state.room);
    return stage ? state.room.stageResults[stage.stageId] : null;
  }

  function getHostPassword(room) {
    return (room.config.settings && room.config.settings.hostPassword) || "host";
  }

  function countdownSeconds() {
    if (!state.room.countdownEndsAt) return 0;
    return Math.max(0, Math.ceil((new Date(state.room.countdownEndsAt).getTime() - Date.now()) / 1000));
  }

  function eventLabel(event) {
    const labels = {
      E1_prediction: `予想: ${event.question || ""}`,
      E2_forbidden: `禁止 ${event.fromFloor}-${event.toFloor}F`,
      E3a_zone_multiplier: `区間倍率 ${event.fromFloor}-${event.toFloor}F x${event.multiplier}`,
      E3b_score_multiplier: `得点倍率 ${event.fromFloor}-${event.toFloor}F x${event.multiplier}`,
      E4_special_floor: `特別階 ${event.floor}F +${event.bonus || event.score || 0}`,
      E5_occupancy_multiplier: `${event.threshold}人以上 x${event.multiplier}`,
      E6_view_bonus: `眺望 x${event.bonusPerExitFloor || event.multiplier || 0}`,
    };
    return labels[event.type] || event.type;
  }

  function phaseLabel(phase) {
    return {
      lobby: "参加者受付中",
      stage_intro: "ステージ説明",
      voting: "チケット購入受付中",
      countdown: "締切カウントダウン",
      tallying: "集計中",
      reveal: "結果発表",
      ranking: "ランキング",
      final: "最終結果",
    }[phase] || phase;
  }

  function statusLabel(status) {
    return {
      success: "乗車成功",
      forced_off: "強制下車",
      invalid: "禁止階",
      not_boarded: "乗車失敗",
      abstained: "棄権",
      absent: "未参加",
    }[status] || status;
  }

  function loadRoom() {
    return loadJson(STORAGE_KEYS.room, null) || Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  }

  function saveRoom(kind, actor) {
    state.room.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEYS.room, JSON.stringify(state.room));
    if (kind) logClient(kind, actor || "");
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function logClient(kind, message) {
    state.logs.unshift({ at: new Date().toISOString(), kind, message: String(message || "") });
    state.logs = state.logs.slice(0, 80);
    localStorage.setItem(STORAGE_KEYS.logs, JSON.stringify(state.logs));
  }

  function showToast(message) {
    state.toast = message;
    render();
    setTimeout(() => {
      state.toast = "";
      render();
    }, 2200);
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function startAudioContext() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = new AudioContext();
      context.resume();
    } catch (error) {
      logClient("audio.error", error.message);
    }
  }

  function isCurrentWinner(uuid) {
    const top = Engine.cumulativeRankings(state.room)[0];
    return top && top.uuid === uuid;
  }

  function isCurrentPodium(uuid) {
    return Engine.cumulativeRankings(state.room).slice(0, 3).some((row) => row.uuid === uuid);
  }

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function formatNumber(value) {
    return Engine.roundScore(value).toFixed(2);
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
})();
