"use strict";

const controls = window.miaArtifactControls;
const locationInput = document.getElementById("location");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const reloadButton = document.getElementById("reload");
const closeButton = document.getElementById("close");
const status = document.getElementById("status");

let currentUrl = "";

function renderState(state) {
  if (!state) return;
  currentUrl = state.url || "";
  if (document.activeElement !== locationInput) locationInput.value = currentUrl;
  backButton.disabled = !state.canGoBack;
  forwardButton.disabled = !state.canGoForward;
  reloadButton.disabled = !currentUrl;
  locationInput.setAttribute("aria-invalid", state.error ? "true" : "false");
  locationInput.title = state.error || "";
  status.className = `status${state.loading ? " loading" : state.error ? " error" : ""}`;
}

backButton.addEventListener("click", () => controls.action("back"));
forwardButton.addEventListener("click", () => controls.action("forward"));
reloadButton.addEventListener("click", () => controls.action("reload"));
closeButton.addEventListener("click", () => controls.action("close"));

const removeStateListener = controls.onState(renderState);
controls.getState().then(renderState);

window.addEventListener("unload", () => {
  removeStateListener();
});
