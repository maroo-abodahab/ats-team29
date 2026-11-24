// AWS Lambda entry point (handler: src/lambda.handler). Same Express app as server.js.
const { lambdaHandler } = require('@ats/shared');
const app = require('./app');

module.exports.handler = lambdaHandler(app);
