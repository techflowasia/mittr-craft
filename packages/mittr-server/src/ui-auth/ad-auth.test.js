import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdAuth, escapeLdapFilterValue } from './ad-auth.js';
import { LDAP_ENV, directoryEntry, fakeDirectory, recordingLogger } from './test-fixtures.js';

const ADA_DN = 'CN=ada,OU=Staff,DC=corp,DC=test';

const directoryWithAda = (over = {}) => fakeDirectory({
  users: { [LDAP_ENV.MITTR_AD_BIND_DN]: LDAP_ENV.MITTR_AD_BIND_PASSWORD, [ADA_DN]: 'correct horse' },
  entries: [directoryEntry('ada')],
  ...over,
});

test('the search filter escapes every RFC 4515 special character', () => {
  assert.equal(escapeLdapFilterValue('a*b(c)d\\e\u0000f'), 'a\\2ab\\28c\\29d\\5ce\\00f');
  assert.equal(escapeLdapFilterValue('*)(sAMAccountName=*'), '\\2a\\29\\28sAMAccountName=\\2a');
  assert.equal(escapeLdapFilterValue('สมชาย'), 'สมชาย');
});

test('a sign-in binds the service account, searches with an escaped filter, then binds as the user', async () => {
  const directory = directoryWithAda();
  const auth = createAdAuth(LDAP_ENV, { createClient: directory.createClient, logger: recordingLogger() });

  const result = await auth.authenticate('ada', 'correct horse');

  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, {
    username: 'ada',
    displayName: 'Ada Lovelace',
    email: 'ada@corp.test',
    department: 'Engineering',
    title: 'Analyst',
    groups: ['Builders'],
  });
  const [client] = directory.clients;
  assert.deepEqual(client.binds, [LDAP_ENV.MITTR_AD_BIND_DN, ADA_DN]);
  assert.equal(client.searches[0].filter, '(sAMAccountName=ada)');
  assert.equal(client.searches[0].base, LDAP_ENV.MITTR_AD_SEARCH_BASE);
  assert.equal(client.searches[0].sizeLimit, 2);
  assert.equal(client.options.url, LDAP_ENV.MITTR_AD_URL);
  assert.ok(client.options.connectTimeout > 0 && client.options.timeout > 0);
  assert.equal(client.options.tlsOptions.rejectUnauthorized, undefined);
  assert.equal(client.closed, true);
});

test('an injected filter is sent escaped', async () => {
  const directory = directoryWithAda({ entries: [] });
  const auth = createAdAuth(LDAP_ENV, { createClient: directory.createClient, logger: recordingLogger() });

  const result = await auth.authenticate('*)(objectClass=*', 'x');

  assert.deepEqual(result, { ok: false, error: 'Invalid credentials' });
  assert.equal(directory.clients[0].searches[0].filter, '(sAMAccountName=\\2a\\29\\28objectClass=\\2a)');
  assert.equal(directory.clients[0].closed, true);
});

test('a wrong password is refused and the client is closed', async () => {
  const directory = directoryWithAda();
  const logger = recordingLogger();
  const auth = createAdAuth(LDAP_ENV, { createClient: directory.createClient, logger });

  const result = await auth.authenticate('ada', 'wrong password');

  assert.deepEqual(result, { ok: false, error: 'Invalid credentials' });
  assert.equal(directory.clients[0].closed, true);
  for (const line of logger.lines) {
    assert.ok(!line.includes('wrong password') && !line.includes(LDAP_ENV.MITTR_AD_BIND_PASSWORD), line);
  }
});

test('an empty password never reaches the directory, so there is no unauthenticated bind', async () => {
  const directory = directoryWithAda();
  const auth = createAdAuth(LDAP_ENV, { createClient: directory.createClient, logger: recordingLogger() });

  assert.deepEqual(await auth.authenticate('ada', ''), { ok: false, error: 'Username and password are required' });
  assert.deepEqual(await auth.authenticate('', 'x'), { ok: false, error: 'Username and password are required' });
  assert.deepEqual(await auth.authenticate('ada\u0000', 'x'), { ok: false, error: 'Username and password are required' });
  assert.deepEqual(await auth.authenticate('a'.repeat(257), 'x'), { ok: false, error: 'Username and password are required' });
  assert.equal(directory.clients.length, 0);
});

test('a user found more than once is refused', async () => {
  const directory = directoryWithAda({ entries: [directoryEntry('ada'), directoryEntry('ada')] });
  const auth = createAdAuth(LDAP_ENV, { createClient: directory.createClient, logger: recordingLogger() });

  assert.deepEqual(await auth.authenticate('ada', 'correct horse'), { ok: false, error: 'Invalid credentials' });
  assert.deepEqual(directory.clients[0].binds, [LDAP_ENV.MITTR_AD_BIND_DN]);
});

test('a bind that never answers times out and still closes the client', async () => {
  const directory = directoryWithAda({ hangOn: 'bind' });
  const auth = createAdAuth(LDAP_ENV, { createClient: directory.createClient, logger: recordingLogger(), timeoutMs: 20 });

  assert.deepEqual(await auth.authenticate('ada', 'correct horse'), { ok: false, error: 'AD server connection timeout' });
  assert.equal(directory.clients[0].closed, true);
});

test('a directory that refuses the connection fails the sign-in and closes the client', async () => {
  const directory = directoryWithAda({ connect: 'error' });
  const auth = createAdAuth(LDAP_ENV, { createClient: directory.createClient, logger: recordingLogger() });

  assert.deepEqual(await auth.authenticate('ada', 'correct horse'), { ok: false, error: 'AD authentication failed' });
  assert.equal(directory.clients[0].closed, true);
});

test('a wrong service account fails the sign-in without trying the user', async () => {
  const directory = fakeDirectory({ users: { [ADA_DN]: 'correct horse' }, entries: [directoryEntry('ada')] });
  const auth = createAdAuth(LDAP_ENV, { createClient: directory.createClient, logger: recordingLogger() });

  assert.deepEqual(await auth.authenticate('ada', 'correct horse'), { ok: false, error: 'AD authentication failed' });
  assert.deepEqual(directory.clients[0].binds, [LDAP_ENV.MITTR_AD_BIND_DN]);
  assert.equal(directory.clients[0].searches.length, 0);
});

test('the profile is read through the service account and cached', async () => {
  const directory = directoryWithAda();
  let clock = 1_000;
  const auth = createAdAuth(LDAP_ENV, { createClient: directory.createClient, logger: recordingLogger(), now: () => clock });

  assert.equal((await auth.getProfile('ada')).displayName, 'Ada Lovelace');
  assert.equal((await auth.getProfile('ADA')).displayName, 'Ada Lovelace');
  assert.equal(directory.clients.length, 1);
  clock += 5 * 60 * 1000 + 1;
  await auth.getProfile('ada');
  assert.equal(directory.clients.length, 2);
  assert.ok(directory.clients.every((client) => client.closed));
});

test('incomplete or unsafe directory settings fail closed', () => {
  const { MITTR_AD_BIND_PASSWORD, ...withoutPassword } = LDAP_ENV;
  assert.ok(MITTR_AD_BIND_PASSWORD);
  const missing = createAdAuth(withoutPassword);
  assert.equal(missing.enabled, false);
  assert.equal(missing.configurationPresent, true);
  assert.equal(missing.configurationError, 'Missing MITTR_AD_BIND_PASSWORD');

  const badUrl = createAdAuth({ ...LDAP_ENV, MITTR_AD_URL: 'https://directory.example.test' });
  assert.equal(badUrl.enabled, false);
  assert.match(badUrl.configurationError, /^MITTR_AD_URL must be/);

  const off = createAdAuth({ ...LDAP_ENV, MITTR_AD_ENABLED: 'false' });
  assert.equal(off.enabled, false);
  assert.equal(off.configurationPresent, false);
});

test('a cleartext directory URL is allowed with a warning', () => {
  const logger = recordingLogger();
  const auth = createAdAuth({ ...LDAP_ENV, MITTR_AD_URL: 'ldap://directory.example.test' }, { logger });

  assert.equal(auth.enabled, true);
  assert.ok(logger.lines.some((line) => line.includes('ldap://')));
});
