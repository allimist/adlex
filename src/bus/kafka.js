/**
 * Kafka event bus (@confluentinc/kafka-javascript, KafkaJS-compatible API).
 * Web processes produce; worker.js consumes and writes to the database in batches.
 * Messages are keyed by clickId so a click and its outclicks stay ordered on one partition.
 */
export class KafkaBus {
  constructor({ kafka: cfg, logger = console, onProduceError } = {}) {
    this.cfg = cfg;
    this.logger = logger;
    this.onProduceError = onProduceError; // (event, err) => void — fallback so a broker outage does not lose clicks
    this.producer = null;
    this.producerReady = null;
    this.consumer = null;
    this.downUntil = 0; // circuit breaker: after a produce failure, skip Kafka for a while
  }

  async _client() {
    if (this.client) return this.client;
    let mod;
    try {
      mod = await import('@confluentinc/kafka-javascript');
    } catch {
      throw new Error('BUS_DRIVER=kafka needs the Kafka client: npm i @confluentinc/kafka-javascript');
    }
    const { Kafka } = (mod.default || mod).KafkaJS;
    const { brokers, clientId, ssl, saslMechanism, saslUsername, saslPassword } = this.cfg;
    const kafkaJS = { clientId, brokers, ssl };
    if (saslMechanism) kafkaJS.sasl = { mechanism: saslMechanism, username: saslUsername, password: saslPassword };
    this.client = new Kafka({ kafkaJS });
    return this.client;
  }

  _connectProducer() {
    if (!this.producerReady) {
      this.producerReady = (async () => {
        const client = await this._client();
        const producer = client.producer({ kafkaJS: { acks: 1 }, 'linger.ms': 5, 'message.timeout.ms': 10000, 'socket.connection.setup.timeout.ms': 10000 });
        await producer.connect();
        this.producer = producer;
        this.logger.info({ msg: 'kafka producer connected', topic: this.cfg.topic });
        return producer;
      })().catch((err) => {
        this.producerReady = null; // retry on the next publish
        throw err;
      });
    }
    return this.producerReady;
  }

  publish(event) {
    if (Date.now() < this.downUntil && this.onProduceError) return this.onProduceError(event, null);
    const key = event.clickId || event.id || '';
    this._connectProducer()
      .then((p) => p.send({ topic: this.cfg.topic, messages: [{ key, value: JSON.stringify(event) }] }))
      .catch((err) => {
        if (Date.now() >= this.downUntil) this.logger.error({ msg: 'kafka produce failed, writing directly for 30s', err: String(err) });
        this.downUntil = Date.now() + 30000;
        if (this.onProduceError) this.onProduceError(event, err);
      });
  }

  async startConsumer(handler) {
    const client = await this._client();
    this.consumer = client.consumer({ kafkaJS: { groupId: this.cfg.groupId, fromBeginning: true } });
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: [this.cfg.topic] });
    await this.consumer.run({
      eachBatch: async ({ batch }) => {
        const events = [];
        for (const m of batch.messages) {
          try {
            events.push(JSON.parse(m.value.toString()));
          } catch {
            this.logger.error({ msg: 'kafka: skipping unparsable message', offset: m.offset });
          }
        }
        // Throwing makes the consumer re-deliver this batch; applyEvents is idempotent.
        await handler(events);
      },
    });
    this.logger.info({ msg: 'kafka consumer running', topic: this.cfg.topic, group: this.cfg.groupId });
  }

  async close() {
    await Promise.allSettled([this.producer && this.producer.disconnect(), this.consumer && this.consumer.disconnect()]);
  }
}
