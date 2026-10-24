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
      case "execute": {
        const operation = params.approval ? { ...params.operation, params: { ...params.operation.params, document_generation: params.approval.documentGeneration, expected_url: params.approval.expectedUrl } } : params.operation;
        return browser.work.execute(binding, operation, { signal: context.signal, approval: params.approval?.runtimeApproval });
      }
      case "approve": {
        const approval = params.approval;
        const checked = browser.work.validate(binding, params.operation);
        if (!approval || checked.documentGeneration !== approval.documentGeneration || checked.url !== approval.expectedUrl) throw Object.assign(new Error("Approval document changed"), { code: "TAB_NAVIGATED" });
        return browser.work.actors.approve({ actorId: binding.actorId, ownerId: binding.ownerId, method: params.operation.method, params: { ...params.operation.params, actor_id: binding.actorId, tab_id: binding.tabId, document_generation: approval.documentGeneration, expected_url: approval.expectedUrl }, expiresAt: approval.expiresAt });
      }
      case "reject": return browser.work.actors.reject(params.approval?.runtimeApproval?.approval_id);
      default: throw new Error("Unsupported browser work method");
    }
  };
}
module.exports = { createBrowserWorkDispatch };
