'use strict';

const dns = require('dns').promises;
const https = require('https');
const net = require('net');

const MAX_BYTES = 100 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon']);
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [base, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked4.addSubnet(base, prefix, 'ipv4');
for (const [base, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['2001:db8::', 32], ['2001::', 32], ['2002::', 16],
]) blocked6.addSubnet(base, prefix, 'ipv6');

function publicAddress(address) {
  const family = net.isIP(address);
  return !!family && !(family === 4 ? blocked4.check(address, 'ipv4') : blocked6.check(address, 'ipv6'));
}

async function fetchAppLogo(value, { resolve = dns.lookup, request = https.get } = {}) {
  if (!value) return null;
  let url;
  try { url = new URL(String(value)); } catch (_) { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || net.isIP(host)
      || host === 'localhost' || /\.(local|internal|lan|home|arpa)$/.test(host)) return null;
  let addresses;
  try { addresses = await resolve(host, { all: true }); } catch (_) { return null; }
  const chosen = addresses.find(item => publicAddress(item.address));
  // A mixed public/private DNS answer is unsafe: a later resolution must not
  // choose a different address. Pin the vetted address for this one request.
  if (!chosen || addresses.some(item => !publicAddress(item.address))) return null;
  return new Promise(done => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; done(value); } };
    const req = request(url, {
      timeout: 5000,
      agent: false,
      lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family),
    }, response => {
      const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const length = Number(response.headers['content-length']);
      if (response.statusCode !== 200 || !TYPES.has(type) || (length && length > MAX_BYTES)) {
        response.destroy(); finish(null); return;
      }
      const chunks = []; let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_BYTES) { response.destroy(); finish(null); return; }
        chunks.push(chunk);
      });
      response.on('end', () => finish(total ? `data:${type};base64,${Buffer.concat(chunks).toString('base64')}` : null));
      response.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

module.exports = { publicAddress, fetchAppLogo };
