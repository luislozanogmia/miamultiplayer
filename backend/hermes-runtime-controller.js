'use strict';

// One owner for runtime transitions. Readers wait until credential maintenance
// and its restart have finished, so a picker cannot adopt a dying gateway.
class HermesRuntimeController {
  constructor(createClient) {
    this.createClient = createClient;
    this.current = null;
    this.tail = Promise.resolve();
    this.closed = false;
  }

  assertOpen() {
    if (this.closed) throw new Error('Hermes gateway controller closed');
  }

  create() {
    this.assertOpen();
    if (this.current?.shutdownRequested) throw new Error('Agent gateway has not finished stopping');
    if (!this.current) this.current = this.createClient();
    return this.current;
  }

  async get() {
    // A transition can be queued while this continuation is waiting.
    for (;;) {
      const pending = this.tail;
      await pending;
      this.assertOpen();
      if (pending === this.tail) {
        if (this.current?.shutdownRequested && this.current.externalGateway) {
          await this.enqueue(() => this.retireDrainedClient());
          continue;
        }
        return this.create();
      }
    }
  }

  enqueue(operation) {
    const result = this.tail.then(() => {
      this.assertOpen();
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async stopCurrent() {
    const client = this.current;
    if (!client) return { stopped: false, external: false };
    const external = Boolean(client.configuredUrl || client.externalGateway);
    if (external && (client.configuredUrl || !client.isListening || await client.isListening())) {
      // Keep the reference: rejecting once must not let a second save bypass it.
      return { stopped: false, external: true };
    }
    const stopped = await client.stopOwnedGateway();
    let listening = false;
    if (stopped && client.waitForListenerExit) listening = !await client.waitForListenerExit();
    else if (client.isListening) listening = await client.isListening();
    if (listening) {
      // A listener not owned by the stopped client must never be adopted for
      // credential maintenance. Keep an external reference across retries.
      // Retain the exact endpoint, including an OS-selected Windows port.
      // A new default-port client could miss this still-draining listener.
      client.externalGateway = true;
      return { stopped, external: true };
    }
    this.current = null;
    return { stopped, external: false };
  }

  async retireDrainedClient() {
    if (this.current?.shutdownRequested && this.current.externalGateway) {
      const { external } = await this.stopCurrent();
      if (external) throw new Error('Agent gateway has not finished stopping');
    }
  }

  stop() {
    return this.enqueue(async () => {
      const { stopped, external } = await this.stopCurrent();
      return stopped && !external;
    });
  }

  start() {
    return this.enqueue(async () => {
      await this.retireDrainedClient();
      await this.create().connect();
      return true;
    });
  }

  restart() {
    return this.enqueue(async () => {
      const previous = this.current;
      const { external } = await this.stopCurrent();
      if (!previous || external) return false;
      await this.create().connect();
      return true;
    });
  }

  withStopped(operation) {
    return this.enqueue(async () => {
      if (!this.current) this.create();
      const { external, stopped } = await this.stopCurrent();
      if (external) throw new Error('An external agent gateway is running; close it before changing connections.');
      let value;
      try {
        value = await operation();
      } catch (error) {
        // Keep the original save error; restarting must not hide it.
        if (stopped) {
          try { await this.create().connect(); } catch (_) { /* reported by the next runtime request */ }
        }
        throw error;
      }
      try {
        await this.create().connect();
        return { value, runtimeReady: true, runtimeError: null };
      } catch (runtimeError) {
        // Credentials are already saved. Retrying runtime startup must not
        // rotate an otherwise usable provider credential.
        return { value, runtimeReady: false, runtimeError };
      }
    });
  }

  close() {
    this.closed = true;
    const client = this.current;
    this.current = null;
    if (client) client.close();
    return Boolean(client);
  }
}

module.exports = { HermesRuntimeController };
