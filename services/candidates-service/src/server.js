// Run this service on a laptop: npm run dev  (uses the Floci profile for AWS calls)
const app = require('./app');

const port = Number(process.env.PORT) || 3002;
app.listen(port, () => console.log(`candidates-service listening on http://localhost:${port}`));
