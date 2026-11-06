'use strict';

// Concurrent requests for the same account share the active operation, including
// an explicit retry. A new request after settlement can start a new operation.
function createAccountSingleFlight() {
  const inFlight = new Map();
  const run = (account, operation) => {
    const key = String(account || '').trim().toLowerCase();
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = Promise.resolve().then(operation);
    inFlight.set(key, promise);
    const release = () => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    };
    promise.then(release, release);
    return promise;
  };
  run.active = account => inFlight.get(String(account || '').trim().toLowerCase()) || null;
  return run;
}

function createCredentialOperationCoordinator() {
  const singleFlight = createAccountSingleFlight();
  let tail = Promise.resolve();
  const mutate = (operation) => {
    const promise = tail.then(operation);
    // A failed operation must not poison unrelated queued provider updates.
    tail = promise.catch(() => {});
    return promise;
  };
  return {
    mutate,
    provision: (account, operation) => singleFlight(account, () => mutate(operation)),
    activeProvision: account => singleFlight.active(account),
  };
}

module.exports = { createCredentialOperationCoordinator };
