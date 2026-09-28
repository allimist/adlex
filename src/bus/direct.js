/** In-process event bus: buffer events and hand them to the consumer in batches. One process only. */
const MAX_BUFFER = 200000; // stop growing if the database is down for a long time

export class DirectBus {
  constructor({ flushMs = 500, batchSize = 500, logger = console } = {}) {
    this.flushMs = flushMs;
    this.batchSize = batchSize;
    this.logger = logger;
    this.buffer = [];
    this.handler = null;
    this.timer = null;
    this.flushing = null;
    this.dropped = 0;
  }

  publish(event) {
    if (this.buffer.length >= MAX_BUFFER) {
      this.dropped++;
      if (this.dropped % 1000 === 1) this.logger.error({ msg: 'direct bus buffer full, dropping events', dropped: this.dropped });
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref?.();
    }
  }

  async startConsumer(handler) {
    this.handler = handler;
  }

  /** Hand the whole buffer to the consumer; on failure put it back and retry on the next tick. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) return this.flushing.then(() => (this.buffer.length ? this.flush() : undefined));
    if (!this.handler || this.buffer.length === 0) return Promise.resolve();
    const events = this.buffer;
    this.buffer = [];
    this.flushing = Promise.resolve()
      .then(() => this.handler(events))
      .catch((err) => {
        this.logger.error({ msg: 'direct bus flush failed, will retry', events: events.length, err: String(err) });
        this.buffer = events.concat(this.buffer);
        if (!this.timer) {
          this.timer = setTimeout(() => this.flush(), Math.max(this.flushMs, 2000));
          this.timer.unref?.();
        }
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  async close() {
    await this.flush();
    if (this.buffer.length) await this.flush();
  }
}
