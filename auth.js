/**
 * One-time Google OAuth2 setup.
 * Run: node auth.js
 * Opens browser to sign in; saves token.json for the server.
 * In Google Cloud Console, add http://localhost:3456/oauth2callback to Authorized redirect URIs.
 */

require('dotenv').config();
const fs = require('fs');
const { google } = require('googleapis');
const http = require('http');

const calendar = require('./lib/calendar');
const credentialsPath = calendar.credentialsPath;
const tokenPath = calendar.tokenPath;
const REDIRECT_URI = 'http://localhost:3456/oauth2callback';

let credentials;
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
} else if (fs.existsSync(credentialsPath)) {
  const content = fs.readFileSync(credentialsPath, 'utf8');
  credentials = JSON.parse(content);
} else {
  console.error('Missing credentials. Set GOOGLE_CREDENTIALS_JSON in .env or add a credentials file at', credentialsPath);
  process.exit(1);
}

const { client_id, client_secret } = credentials.installed || credentials.web;
const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: calendar.SCOPES,
  prompt: 'consent',
  redirect_uri: REDIRECT_URI,
});

const server = http.createServer(async (req, res) => {
  if (req.url.indexOf('/oauth2callback') === -1) {
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }
  const q = new URL(req.url, 'http://localhost:3456').searchParams;
  const code = q.get('code');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<p>Authorized. You can close this tab and return to the terminal.</p>');
  server.close();

  const { tokens } = await oauth2Client.getToken({ code, redirect_uri: REDIRECT_URI });
  oauth2Client.setCredentials(tokens);
  fs.writeFileSync(tokenPath, JSON.stringify(tokens), 'utf8');
  console.log('Token saved to', tokenPath);
  if (process.env.GOOGLE_TOKEN_JSON) {
    console.log('You have GOOGLE_TOKEN_JSON in .env. Either remove it (app will use token.json) or update GOOGLE_TOKEN_JSON with the contents of', tokenPath);
  }
  process.exit(0);
});

server.listen(3456, () => {
  console.log('Open this URL in your browser to sign in:');
  console.log(authUrl);
});
