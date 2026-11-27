// Application events -> Amazon SQS queue "ats-application-events" (owner: Laila).
// The notifier Lambda (May's service) is triggered by this queue and emails the
// candidate an "application received / withdrawn" confirmation. Using a queue means:
// - submitting an application never waits for (or fails because of) the email API;
// - if the email API is down, SQS retries, then moves the message to a dead-letter queue.
const { SQSClient, SendMessageCommand, GetQueueUrlCommand } = require('@aws-sdk/client-sqs');
const { log } = require('@ats/shared');

const sqs = new SQSClient({});
let queueUrl;

async function publish(type, payload) {
  try {
    if (!queueUrl) {
      const out = await sqs.send(new GetQueueUrlCommand({ QueueName: process.env.APPLICATION_QUEUE || 'ats-application-events' }));
      queueUrl = out.QueueUrl;
    }
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ type, ...payload, occurredAt: new Date().toISOString() }),
      MessageAttributes: { type: { DataType: 'String', StringValue: type } }
    }));
    log.info('EVENT_PUBLISHED', { type, applicationId: payload.applicationId });
  } catch (err) {
    // The application itself is already saved; a lost confirmation email is logged, not fatal.
    log.error('EVENT_PUBLISH_FAILED', { type, applicationId: payload.applicationId, error: err.message });
  }
}

module.exports = { publish };
