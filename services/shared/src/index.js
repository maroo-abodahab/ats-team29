// @ats/shared: the pieces every ATS service needs, written once so the
// three services behave the same way (same login, same roles, same errors,
// same log format). Each service still has its OWN Lambda, tables and IAM role.
module.exports = {
  ...require('./errors'),
  ...require('./logger'),
  ...require('./auth'),
  ...require('./validate'),
  ...require('./secrets'),
  ...require('./serviceClient'),
  ...require('./createApp'),
  ...require('./rateLimit'),
  ...require('./dynamo')
};
