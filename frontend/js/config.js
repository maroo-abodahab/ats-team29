// Frontend configuration. NOTHING here is secret: every visitor can read this file.
// infra/services/60-frontend.sh writes the API address in for you.
const FLOCI_API = 'http://30beff2cb5.execute-api.localhost.floci.io:4566';
const AWS_API = 'https://YOUR-AWS-API-ID.execute-api.us-east-1.amazonaws.com';

// Pick the API from where the page was loaded (same idea as the Lab 7 config.js):
//   port 4566 -> website on Floci S3 -> Floci API Gateway
//   amazonaws.com -> website on real S3 -> real API Gateway
//   anything else (e.g. a local static server) -> Floci API
const API_ROOT = window.location.hostname.endsWith('amazonaws.com') ? AWS_API : FLOCI_API;
