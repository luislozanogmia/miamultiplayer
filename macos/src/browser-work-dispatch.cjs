"use strict";
function createBrowserWorkDispatch(getBrowser) {
  return async (method, params, context) => {
    const browser = getBrowser();
    if (!browser?.work) throw Object.assign(new Error("Browser is not ready"), { code: "BROWSER_UNAVAILABLE" });
    const binding = params.binding && { ...params.binding, taskId: params.binding.workerId };
    switch (method) {
      case "state": return browser.state();
      case "bind": return browser.work.actors.bind(binding);
      case "revoke": return browser.work.actors.revoke(binding.actorId);
      case "validate": return browser.work.validate(binding, params.operation);
      case "execute": return browser.work.execute(binding, params.operation, { signal: context.signal });
      default: throw new Error("Unsupported browser work method");
    }
  };
}
module.exports = { createBrowserWorkDispatch };
