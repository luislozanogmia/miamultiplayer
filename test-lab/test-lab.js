(() => {
  "use strict";

  const STORAGE_KEY = "miaos.testLab.v3";
  // Keep framebuffer pixels and pointer coordinates 1:1. noVNC's scale mode
  // is useful for passive viewing, but coordinate-driven acceptance tools can
  // otherwise click an adjacent control after the canvas is fitted.
  const DEFAULT_URLS = [7901, 7902, 7903, 7904].map(
    (port) => `http://127.0.0.1:${port}/vnc.html?autoconnect=1&resize=off&reconnect=1&shared=1`,
  );
  const SCENARIOS = [
    "Fresh install and onboarding",
    "Model selection and Mia chat",
    "Bot creation and automation",
    "Browser automation and clean slate",
  ];

  const grid = document.querySelector("#laneGrid");
  const template = document.querySelector("#laneTemplate");
  const configureButton = document.querySelector("#configureButton");
  const configurationPanel = document.querySelector("#configurationPanel");
  const configurationForm = document.querySelector("#configurationForm");
  const urlFields = document.querySelector("#urlFields");
  const onlineCount = document.querySelector("#onlineCount");
  const runSummary = document.querySelector("#runSummary");
  const lanes = [];

  function readSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return {
        urls: Array.isArray(stored?.urls) && stored.urls.length === 4 ? stored.urls : DEFAULT_URLS,
        states: Array.isArray(stored?.states) && stored.states.length === 4 ? stored.states : Array(4).fill("queued"),
      };
    } catch {
      return { urls: DEFAULT_URLS, states: Array(4).fill("queued") };
    }
  }

  let settings = readSettings();

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function normalizeUrl(value) {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Use an http:// or https:// noVNC URL.");
    return url.href;
  }

  function updateSummary() {
    onlineCount.textContent = String(lanes.filter(({ card }) => card.dataset.connection === "online").length);
    const counts = settings.states.reduce((result, state) => {
      result[state] = (result[state] || 0) + 1;
      return result;
    }, {});
    runSummary.textContent = ["running", "failed", "passed", "queued"]
      .filter((state) => counts[state])
      .map((state) => `${counts[state]} ${state}`)
      .join(" · ");
  }

  function setConnection(lane, connection) {
    lane.card.dataset.connection = connection;
    lane.badge.dataset.connection = connection;
    lane.label.textContent = connection === "online" ? "Online" : connection === "offline" ? "Offline" : "Checking";
    updateSummary();
  }

  async function checkConnectivity(index) {
    const lane = lanes[index];
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4000);
    try {
      await fetch(settings.urls[index], {
        cache: "no-store",
        mode: "no-cors",
        signal: controller.signal,
      });
      setConnection(lane, "online");
    } catch {
      setConnection(lane, "offline");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function loadLane(index) {
    const lane = lanes[index];
    setConnection(lane, "checking");
    lane.url.textContent = settings.urls[index];
    lane.frame.src = settings.urls[index];
    void checkConnectivity(index);
  }

  function buildUrlFields() {
    urlFields.replaceChildren();
    settings.urls.forEach((value, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "url-field";
      const label = document.createElement("label");
      label.htmlFor = `laneUrl${index + 1}`;
      label.textContent = `Lane ${index + 1}`;
      const input = document.createElement("input");
      input.id = label.htmlFor;
      input.name = `lane${index + 1}`;
      input.type = "url";
      input.required = true;
      input.spellcheck = false;
      input.value = value;
      wrapper.append(label, input);
      urlFields.append(wrapper);
    });
  }

  function renderLanes() {
    grid.replaceChildren();
    lanes.length = 0;
    SCENARIOS.forEach((scenario, index) => {
      const fragment = template.content.cloneNode(true);
      const card = fragment.querySelector(".lane-card");
      const frame = fragment.querySelector(".lane-screen");
      const badge = fragment.querySelector(".connection-badge");
      const label = fragment.querySelector(".connection-label");
      const state = fragment.querySelector(".state-select");
      const url = fragment.querySelector(".lane-url");
      const focus = fragment.querySelector(".focus-button");
      const reload = fragment.querySelector(".reload-button");
      const title = `Lane ${index + 1}`;

      card.dataset.state = settings.states[index];
      card.dataset.connection = "checking";
      fragment.querySelector(".lane-number").textContent = String(index + 1).padStart(2, "0");
      fragment.querySelector(".lane-title").textContent = title;
      fragment.querySelector(".lane-scenario").textContent = scenario;
      frame.title = `${title}: ${scenario}`;
      state.value = settings.states[index];

      const lane = { card, frame, badge, label, state, url };
      lanes.push(lane);

      state.addEventListener("change", () => {
        settings.states[index] = state.value;
        card.dataset.state = state.value;
        saveSettings();
        updateSummary();
      });
      reload.addEventListener("click", () => loadLane(index));
      focus.addEventListener("click", () => {
        const focused = card.classList.toggle("is-focused");
        focus.textContent = focused ? "Exit focus" : "Focus";
        focus.setAttribute("aria-pressed", String(focused));
      });

      grid.append(fragment);
      loadLane(index);
    });
    updateSummary();
  }

  configureButton.addEventListener("click", () => {
    const opening = configurationPanel.hidden;
    configurationPanel.hidden = !opening;
    document.body.classList.toggle("has-configuration", opening);
    configureButton.setAttribute("aria-expanded", String(opening));
    if (opening) buildUrlFields();
  });

  configurationForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(configurationForm);
    try {
      settings.urls = DEFAULT_URLS.map((_, index) => normalizeUrl(data.get(`lane${index + 1}`)));
    } catch (error) {
      configurationForm.querySelector("input:invalid")?.focus();
      window.alert(error.message);
      return;
    }
    saveSettings();
    lanes.forEach((_, index) => loadLane(index));
    configurationPanel.hidden = true;
    document.body.classList.remove("has-configuration");
    configureButton.setAttribute("aria-expanded", "false");
  });

  document.querySelector("#restoreDefaults").addEventListener("click", () => {
    settings.urls = [...DEFAULT_URLS];
    saveSettings();
    buildUrlFields();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const focused = document.querySelector(".lane-card.is-focused");
    if (focused) {
      focused.classList.remove("is-focused");
      const button = focused.querySelector(".focus-button");
      button.textContent = "Focus";
      button.setAttribute("aria-pressed", "false");
    }
  });

  renderLanes();
  window.setInterval(() => {
    lanes.forEach((_, index) => void checkConnectivity(index));
  }, 15000);
})();
