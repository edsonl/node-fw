import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as tar from 'tar';

import { MAXMIND_EDITIONS } from '../src/enrichment/maxmind-editions.js';
import {
    extractMmdbFromTarball,
    rollbackMaxMindEdition,
    runMaxMindUpdate,
} from '../src/enrichment/maxmind-updater.js';

const COUNTRY = MAXMIND_EDITIONS[0];
const ASN = MAXMIND_EDITIONS[1];

function updaterConfig(dbDir, overrides = {}) {
    return {
        enabled: true,
        dbDir,
        accountId: 'account-secret',
        licenseKey: 'license-secret',
        refreshMaxAgeDays: 3,
        downloadTimeoutMs: 1000,
        downloadRetries: 1,
        retryBackoffMs: 0,
        cacheMaxEntries: 100,
        cacheTtlMs: 60000,
        lockStaleMs: 60000,
        ...overrides,
    };
}

function createLogger() {
    const entries = [];
    const record = (level) => (context, message) => {
        entries.push({ level, context, message });
    };
    return {
        entries,
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
    };
}

async function createTarFixture(root, edition, content, directoryName) {
    const fixtureRoot = join(root, `fixture-${edition.key}`);
    const directory = join(fixtureRoot, directoryName);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, edition.fileName), content);
    await writeFile(join(directory, 'COPYRIGHT.txt'), 'fixture');

    const file = join(root, `${edition.key}.tar.gz`);
    await tar.c({
        gzip: true,
        file,
        cwd: fixtureRoot,
    }, [directoryName]);
    return file;
}

function fakeOpenDatabase() {
    return async (filePath) => {
        const content = await readFile(filePath, 'utf8');
        if (content.includes('CORRUPT')) {
            throw new Error('corrupt database');
        }
        if (content.trim() === '') {
            throw new Error('empty database');
        }

        const edition = filePath.includes('GeoLite2-Country') ? COUNTRY : ASN;
        return {
            metadata: {
                buildEpoch: new Date('2026-11-10T00:00:00.000Z'),
                databaseType: edition.name,
                ipVersion: 6,
            },
            dispose() {},
        };
    };
}

function createFetch(tarPaths, calls = []) {
    return async (url) => {
        const parsed = new URL(url);
        const editionId = parsed.searchParams.get('edition_id');
        calls.push(editionId);
        const tarPath = tarPaths[editionId];
        if (!tarPath) {
            return new Response('not found', { status: 404 });
        }
        const buffer = await readFile(tarPath);
        return new Response(buffer, {
            status: 200,
            headers: { 'content-length': String(buffer.length) },
        });
    };
}

test('updates Country and ASN, writes manifest and preserves no secrets', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nodefw-maxmind-update-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbDir = join(root, 'geolite2');
    await mkdir(dbDir);

    const countryTar = await createTarFixture(root, COUNTRY, 'FAKE-MMDB-COUNTRY', 'GeoLite2-Country_20261110');
    const asnTar = await createTarFixture(root, ASN, 'FAKE-MMDB-ASN', 'GeoLite2-ASN_20261110');
    const logger = createLogger();
    const calls = [];

    const result = await runMaxMindUpdate({
        config: updaterConfig(dbDir),
        logger,
        fetchImpl: createFetch({
            [COUNTRY.name]: countryTar,
            [ASN.name]: asnTar,
        }, calls),
        openDatabase: fakeOpenDatabase(),
    });

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.results.map((item) => item.status), ['updated', 'updated']);
    assert.equal((await readFile(join(dbDir, COUNTRY.fileName), 'utf8')), 'FAKE-MMDB-COUNTRY');
    assert.equal((await readFile(join(dbDir, ASN.fileName), 'utf8')), 'FAKE-MMDB-ASN');

    const manifestText = await readFile(join(dbDir, 'manifest.json'), 'utf8');
    assert.equal(manifestText.includes('license-secret'), false);
    assert.equal(manifestText.includes('account-secret'), false);
    assert.equal(JSON.stringify(logger.entries).includes('license-secret'), false);

    const countryHash = createHash('sha256').update('FAKE-MMDB-COUNTRY').digest('hex');
    assert.equal(JSON.parse(manifestText).editions[COUNTRY.name].sha256, countryHash);
    assert.equal(calls.length, 2);
});

test('keeps .previous and restores it with rollback', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nodefw-maxmind-rollback-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbDir = join(root, 'geolite2');
    await mkdir(dbDir);

    await writeFile(join(dbDir, COUNTRY.fileName), 'OLD-COUNTRY');
    const countryTar = await createTarFixture(root, COUNTRY, 'NEW-COUNTRY', 'GeoLite2-Country_20261110');
    const logger = createLogger();

    const result = await runMaxMindUpdate({
        config: updaterConfig(dbDir),
        logger,
        editions: [COUNTRY],
        force: true,
        fetchImpl: createFetch({ [COUNTRY.name]: countryTar }),
        openDatabase: fakeOpenDatabase(),
    });

    assert.equal(result.status, 'ok');
    assert.equal(await readFile(join(dbDir, COUNTRY.fileName), 'utf8'), 'NEW-COUNTRY');
    assert.equal(await readFile(`${join(dbDir, COUNTRY.fileName)}.previous`, 'utf8'), 'OLD-COUNTRY');

    const rollback = await rollbackMaxMindEdition({
        config: { dbDir },
        editionName: COUNTRY.name,
        openDatabase: fakeOpenDatabase(),
    });

    assert.equal(rollback.status, 'restored');
    assert.equal(await readFile(join(dbDir, COUNTRY.fileName), 'utf8'), 'OLD-COUNTRY');
});

test('HTTP failure preserves the active database and does not leak the URL', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nodefw-maxmind-http-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbDir = join(root, 'geolite2');
    await mkdir(dbDir);
    await writeFile(join(dbDir, COUNTRY.fileName), 'OLD-COUNTRY');
    const logger = createLogger();

    const result = await runMaxMindUpdate({
        config: updaterConfig(dbDir, { downloadRetries: 1 }),
        logger,
        editions: [COUNTRY],
        force: true,
        fetchImpl: async () => new Response('failure', { status: 500 }),
        openDatabase: fakeOpenDatabase(),
    });

    assert.equal(result.status, 'partial_failure');
    assert.equal(result.results[0].status, 'failed');
    assert.equal(result.results[0].reason, 'http_500');
    assert.equal(await readFile(join(dbDir, COUNTRY.fileName), 'utf8'), 'OLD-COUNTRY');
    assert.equal(JSON.stringify(logger.entries).includes('license-secret'), false);
});

test('retries transient HTTP failures and then updates', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nodefw-maxmind-retry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbDir = join(root, 'geolite2');
    await mkdir(dbDir);
    const countryTar = await createTarFixture(root, COUNTRY, 'RETRY-COUNTRY', 'GeoLite2-Country_20261110');
    const buffer = await readFile(countryTar);
    let calls = 0;

    const result = await runMaxMindUpdate({
        config: updaterConfig(dbDir, { downloadRetries: 2 }),
        editions: [COUNTRY],
        fetchImpl: async () => {
            calls += 1;
            if (calls < 3) {
                return new Response('temporary failure', { status: 500 });
            }
            return new Response(buffer, {
                status: 200,
                headers: { 'content-length': String(buffer.length) },
            });
        },
        openDatabase: fakeOpenDatabase(),
    });

    assert.equal(result.status, 'ok');
    assert.equal(calls, 3);
    assert.equal(result.results[0].attempts, 3);
    assert.equal(await readFile(join(dbDir, COUNTRY.fileName), 'utf8'), 'RETRY-COUNTRY');
});

test('tar and MMDB failures preserve the active database', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nodefw-maxmind-invalid-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbDir = join(root, 'geolite2');
    await mkdir(dbDir);
    await writeFile(join(dbDir, COUNTRY.fileName), 'OLD-COUNTRY');
    const logger = createLogger();

    const invalidTar = await runMaxMindUpdate({
        config: updaterConfig(dbDir),
        logger,
        editions: [COUNTRY],
        force: true,
        fetchImpl: async () => new Response('not a tar', { status: 200 }),
        openDatabase: fakeOpenDatabase(),
    });
    assert.equal(invalidTar.status, 'partial_failure');
    assert.equal(await readFile(join(dbDir, COUNTRY.fileName), 'utf8'), 'OLD-COUNTRY');

    const corruptTar = await createTarFixture(root, COUNTRY, 'CORRUPT', 'GeoLite2-Country_20261110');
    const invalidMmdb = await runMaxMindUpdate({
        config: updaterConfig(dbDir),
        logger,
        editions: [COUNTRY],
        force: true,
        fetchImpl: createFetch({ [COUNTRY.name]: corruptTar }),
        openDatabase: fakeOpenDatabase(),
    });
    assert.equal(invalidMmdb.status, 'partial_failure');
    assert.equal(await readFile(join(dbDir, COUNTRY.fileName), 'utf8'), 'OLD-COUNTRY');
});

test('does not download when the database is fresh or when locked', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nodefw-maxmind-skip-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbDir = join(root, 'geolite2');
    await mkdir(dbDir);
    await writeFile(join(dbDir, COUNTRY.fileName), 'FRESH-COUNTRY');

    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        return new Response('', { status: 500 });
    };

    const fresh = await runMaxMindUpdate({
        config: updaterConfig(dbDir),
        editions: [COUNTRY],
        fetchImpl,
        openDatabase: fakeOpenDatabase(),
    });
    assert.equal(fresh.status, 'ok');
    assert.equal(fresh.results[0].status, 'skipped');
    assert.equal(calls, 0);

    await writeFile(join(dbDir, '.update.lock'), '{"pid":1}');
    const locked = await runMaxMindUpdate({
        config: updaterConfig(dbDir),
        editions: [COUNTRY],
        fetchImpl,
        openDatabase: fakeOpenDatabase(),
    });
    assert.equal(locked.status, 'locked');
    assert.equal(calls, 0);
});

test('rejects tar path traversal and unexpected MMDB entries', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nodefw-maxmind-tar-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const extractDir = join(root, 'extract');
    await mkdir(extractDir);

    const traversalTar = {
        async t({ onentry }) {
            onentry({ path: '../evil.mmdb', type: 'File' });
        },
        async x() {
            throw new Error('must not extract');
        },
    };
    await assert.rejects(
        () => extractMmdbFromTarball({
            tarballPath: join(root, 'traversal.tar.gz'),
            extractDir,
            edition: COUNTRY,
            tarImpl: traversalTar,
        }),
        (error) => error.code === 'unsafe_tar_entry'
    );

    const extraMmdbTar = {
        async t({ onentry }) {
            onentry({ path: 'one/GeoLite2-Country.mmdb', type: 'File' });
            onentry({ path: 'one/evil.mmdb', type: 'File' });
        },
        async x() {
            throw new Error('must not extract');
        },
    };
    await assert.rejects(
        () => extractMmdbFromTarball({
            tarballPath: join(root, 'extra.tar.gz'),
            extractDir,
            edition: COUNTRY,
            tarImpl: extraMmdbTar,
        }),
        (error) => error.code === 'unexpected_mmdb_entries'
    );
});

test('requires credentials and only exposes safe result fields', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nodefw-maxmind-config-'));
    t.after(() => rm(root, { recursive: true, force: true }));

    const missing = await runMaxMindUpdate({
        config: updaterConfig(root, { licenseKey: '' }),
        fetchImpl: async () => {
            throw new Error('must not fetch');
        },
    });
    assert.equal(missing.status, 'not_configured');

    const disabled = await runMaxMindUpdate({
        config: updaterConfig(root, { enabled: false }),
    });
    assert.equal(disabled.status, 'disabled');
});
