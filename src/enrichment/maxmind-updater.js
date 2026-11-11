import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    open,
    readFile,
    rename,
    rm,
    stat,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import { open as openMaxMind } from 'maxmind';
import * as tar from 'tar';

import { findMaxMindEdition, MAXMIND_EDITIONS } from './maxmind-editions.js';

const MANIFEST_FILE = 'manifest.json';
const LOCK_FILE = '.update.lock';
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const FILE_MODE = 0o640;

export class MaxMindUpdateError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'MaxMindUpdateError';
        this.code = code;
    }
}

function safeErrorCode(error) {
    if (error instanceof MaxMindUpdateError) {
        return error.code;
    }
    if (error && typeof error.code === 'string') {
        return error.code;
    }
    if (error && typeof error.name === 'string' && error.name !== 'Error') {
        return error.name;
    }
    return 'update_failed';
}

function sleep(ms) {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, ms);
    });
}

function isRetryableDownloadError(error) {
    return error.code === 'network_error'
        || error.code === 'timeout'
        || error.code === 'http_429'
        || /^http_5\d\d$/.test(error.code);
}

function normalizeDownloadError(error) {
    if (error instanceof MaxMindUpdateError) {
        return error;
    }
    if (error?.name === 'AbortError') {
        return new MaxMindUpdateError('timeout', 'MaxMind download timed out');
    }
    if (error?.name === 'TypeError') {
        return new MaxMindUpdateError('network_error', 'MaxMind download failed');
    }
    return new MaxMindUpdateError('download_failed', 'MaxMind download failed');
}

function buildDownloadUrl(edition, licenseKey) {
    const url = new URL('https://download.maxmind.com/app/geoip_download');
    url.searchParams.set('edition_id', edition.name);
    url.searchParams.set('license_key', licenseKey);
    url.searchParams.set('suffix', 'tar.gz');
    return url;
}

async function downloadToFile({
    edition,
    config,
    targetPath,
    fetchImpl,
    logger,
}) {
    const attempts = Math.min(6, Math.max(1, config.downloadRetries + 1));
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetchImpl(buildDownloadUrl(edition, config.licenseKey), {
                redirect: 'follow',
                signal: AbortSignal.timeout(config.downloadTimeoutMs),
            });

            if (!response || typeof response.status !== 'number') {
                throw new MaxMindUpdateError('invalid_response', 'MaxMind returned an invalid response');
            }
            if (!response.ok) {
                throw new MaxMindUpdateError(`http_${response.status}`, 'MaxMind download failed');
            }

            const contentLength = Number(response.headers?.get?.('content-length'));
            if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
                throw new MaxMindUpdateError('download_too_large', 'MaxMind archive is too large');
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length === 0) {
                throw new MaxMindUpdateError('empty_download', 'MaxMind archive is empty');
            }
            if (buffer.length > MAX_DOWNLOAD_BYTES) {
                throw new MaxMindUpdateError('download_too_large', 'MaxMind archive is too large');
            }

            await writeFile(targetPath, buffer, { mode: 0o600 });
            return { attempts: attempt, bytes: buffer.length };
        } catch (error) {
            lastError = normalizeDownloadError(error);
            if (attempt >= attempts || !isRetryableDownloadError(lastError)) {
                throw lastError;
            }

            logger?.warn(
                { edition: edition.name, attempt, code: lastError.code },
                'maxmind download failed; retrying'
            );
            await sleep(config.retryBackoffMs * attempt);
        }
    }

    throw lastError ?? new MaxMindUpdateError('download_failed', 'MaxMind download failed');
}

function validateArchiveEntry(entry) {
    if (typeof entry.path !== 'string' || entry.path === '' || entry.path.includes('\0')) {
        throw new MaxMindUpdateError('unsafe_tar_entry', 'MaxMind archive contains an unsafe entry');
    }

    const normalized = entry.path.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
        throw new MaxMindUpdateError('unsafe_tar_entry', 'MaxMind archive contains an absolute path');
    }

    if (normalized.split('/').filter(Boolean).includes('..')) {
        throw new MaxMindUpdateError('unsafe_tar_entry', 'MaxMind archive contains path traversal');
    }
}

export async function extractMmdbFromTarball({
    tarballPath,
    extractDir,
    edition,
    tarImpl = tar,
}) {
    const entries = [];
    await tarImpl.t({
        file: tarballPath,
        onentry: (entry) => {
            validateArchiveEntry(entry);
            entries.push({
                path: entry.path,
                type: entry.type ?? 'File',
            });
        },
    });

    const allMmdbEntries = entries.filter((entry) => entry.path.toLowerCase().endsWith('.mmdb'));
    const mmdbEntries = entries.filter((entry) => basename(entry.path) === edition.fileName);
    if (allMmdbEntries.length !== 1 || mmdbEntries.length !== 1) {
        throw new MaxMindUpdateError('unexpected_mmdb_entries', 'MaxMind archive must contain one expected MMDB');
    }

    const mmdbEntry = mmdbEntries[0];
    if (!['File', 'OldFile', 'ContiguousFile'].includes(mmdbEntry.type)) {
        throw new MaxMindUpdateError('unexpected_mmdb_type', 'MaxMind MMDB entry is not a regular file');
    }

    const root = `${resolve(extractDir)}${sep}`;
    const targetPath = resolve(extractDir, mmdbEntry.path);
    if (!targetPath.startsWith(root)) {
        throw new MaxMindUpdateError('unsafe_tar_entry', 'MaxMind MMDB path escapes extraction directory');
    }

    await tarImpl.x({
        file: tarballPath,
        cwd: extractDir,
        strict: true,
        preservePaths: false,
        filter: (entryPath) => entryPath === mmdbEntry.path,
    });

    const info = await stat(targetPath).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
        throw new MaxMindUpdateError('mmdb_missing', 'MaxMind MMDB was not extracted');
    }

    return targetPath;
}

export async function validateMmdbFile(filePath, { openDatabase = openMaxMind, edition } = {}) {
    let reader;
    try {
        reader = await openDatabase(filePath);
        const metadata = reader?.metadata;
        if (!metadata || metadata.buildEpoch === undefined || metadata.buildEpoch === null) {
            throw new MaxMindUpdateError('invalid_mmdb', 'MaxMind database metadata is invalid');
        }

        const buildEpoch = metadata.buildEpoch instanceof Date
            ? metadata.buildEpoch
            : new Date(metadata.buildEpoch);
        if (Number.isNaN(buildEpoch.getTime())) {
            throw new MaxMindUpdateError('invalid_mmdb', 'MaxMind build epoch is invalid');
        }

        if (edition && metadata.databaseType && metadata.databaseType !== edition.name) {
            throw new MaxMindUpdateError('wrong_database_type', 'MaxMind database type does not match edition');
        }

        return {
            buildEpoch: buildEpoch.toISOString(),
            databaseType: metadata.databaseType ?? null,
            ipVersion: metadata.ipVersion ?? null,
        };
    } finally {
        if (reader) {
            reader.dispose?.();
            reader.close?.();
        }
    }
}

async function sha256File(filePath) {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    for await (const chunk of stream) {
        hash.update(chunk);
    }

    return hash.digest('hex');
}

async function fileExists(filePath) {
    return Boolean(await stat(filePath).catch(() => null));
}

async function installDatabase({
    sourcePath,
    activePath,
    edition,
    openDatabase,
}) {
    const nextPath = `${activePath}.next`;
    const previousPath = `${activePath}.previous`;

    try {
        await copyFile(sourcePath, nextPath);
        await chmod(nextPath, FILE_MODE);
        await validateMmdbFile(nextPath, { openDatabase, edition });

        const hadActive = await fileExists(activePath);
        if (hadActive) {
            await copyFile(activePath, previousPath);
            await chmod(previousPath, FILE_MODE);
        }

        await rename(nextPath, activePath);
        return { previous: hadActive };
    } catch (error) {
        await rm(nextPath, { force: true });
        throw error;
    }
}

export async function rollbackMaxMindEdition({
    config,
    editionName,
    openDatabase = openMaxMind,
}) {
    const edition = findMaxMindEdition(editionName);
    if (!edition) {
        throw new MaxMindUpdateError('unknown_edition', 'Unknown MaxMind edition');
    }

    const activePath = join(config.dbDir, edition.fileName);
    const previousPath = `${activePath}.previous`;
    const nextPath = `${activePath}.next`;

    if (!await fileExists(previousPath)) {
        throw new MaxMindUpdateError('previous_missing', 'Previous MaxMind database is not available');
    }

    try {
        await copyFile(previousPath, nextPath);
        await chmod(nextPath, FILE_MODE);
        await validateMmdbFile(nextPath, { openDatabase, edition });
        await rename(nextPath, activePath);
        return {
            edition: edition.name,
            status: 'restored',
            previous: previousPath,
        };
    } catch (error) {
        await rm(nextPath, { force: true });
        throw error;
    }
}

function manifestPath(dbDir) {
    return join(dbDir, MANIFEST_FILE);
}

async function readManifest(dbDir) {
    try {
        const parsed = JSON.parse(await readFile(manifestPath(dbDir), 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return {
                schemaVersion: 1,
                ...parsed,
                editions: parsed.editions && typeof parsed.editions === 'object'
                    ? parsed.editions
                    : {},
            };
        }
    } catch {
        // A missing or corrupt manifest does not affect the active database.
    }

    return {
        schemaVersion: 1,
        editions: {},
    };
}

async function writeManifest(dbDir, manifest) {
    const target = manifestPath(dbDir);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: FILE_MODE });
    await rename(temporary, target);
}

async function isFreshDatabase({
    activePath,
    edition,
    config,
    openDatabase,
    now,
}) {
    const info = await stat(activePath).catch(() => null);
    if (!info) {
        return false;
    }

    const ageMs = now().getTime() - info.mtimeMs;
    if (ageMs > config.refreshMaxAgeDays * 24 * 60 * 60 * 1000) {
        return false;
    }

    try {
        await validateMmdbFile(activePath, { openDatabase, edition });
        return true;
    } catch {
        return false;
    }
}

async function acquireLock(lockPath, staleMs, now) {
    const tryAcquire = async () => {
        try {
            const handle = await open(lockPath, 'wx', 0o600);
            await handle.writeFile(JSON.stringify({
                pid: process.pid,
                createdAt: now().toISOString(),
            }));
            return {
                release: async () => {
                    await handle.close().catch(() => {});
                    await unlink(lockPath).catch(() => {});
                },
            };
        } catch (error) {
            if (error?.code !== 'EEXIST') {
                throw error;
            }
            return null;
        }
    };

    const lock = await tryAcquire();
    if (lock) {
        return lock;
    }

    const info = await stat(lockPath).catch(() => null);
    if (!info) {
        return tryAcquire();
    }
    if (now().getTime() - info.mtimeMs > staleMs) {
        await unlink(lockPath).catch(() => {});
        return tryAcquire();
    }

    return null;
}

async function updateEdition({
    edition,
    config,
    logger,
    fetchImpl,
    tarImpl,
    openDatabase,
    now,
    force,
}) {
    const activePath = join(config.dbDir, edition.fileName);

    try {
        if (!force && await isFreshDatabase({
            activePath,
            edition,
            config,
            openDatabase,
            now,
        })) {
            return {
                edition: edition.name,
                status: 'skipped',
                reason: 'fresh',
            };
        }

        const workDir = await mkdtemp(join(config.dbDir, '.work-'));
        try {
            const tarballPath = join(workDir, 'download.tar.gz');
            const extractDir = join(workDir, 'extract');
            await mkdir(extractDir, { recursive: true, mode: 0o750 });

            const download = await downloadToFile({
                edition,
                config,
                targetPath: tarballPath,
                fetchImpl,
                logger,
            });
            const mmdbPath = await extractMmdbFromTarball({
                tarballPath,
                extractDir,
                edition,
                tarImpl,
            });
            const metadata = await validateMmdbFile(mmdbPath, { openDatabase, edition });
            const sha256 = await sha256File(mmdbPath);
            const size = (await stat(mmdbPath)).size;
            const installed = await installDatabase({
                sourcePath: mmdbPath,
                activePath,
                edition,
                openDatabase,
            });

            const manifest = await readManifest(config.dbDir);
            const updatedAt = now().toISOString();
            manifest.updatedAt = updatedAt;
            manifest.editions[edition.name] = {
                fileName: edition.fileName,
                sha256,
                size,
                buildEpoch: metadata.buildEpoch,
                databaseType: metadata.databaseType,
                updatedAt,
            };

            try {
                await writeManifest(config.dbDir, manifest);
            } catch (error) {
                logger?.warn(
                    { edition: edition.name, code: safeErrorCode(error) },
                    'maxmind database updated but manifest write failed'
                );
            }

            return {
                edition: edition.name,
                status: 'updated',
                sha256,
                size,
                buildEpoch: metadata.buildEpoch,
                previous: installed.previous,
                attempts: download.attempts,
            };
        } finally {
            await rm(workDir, { recursive: true, force: true });
        }
    } catch (error) {
        logger?.warn(
            { edition: edition.name, code: safeErrorCode(error) },
            'maxmind update failed; active database preserved'
        );
        return {
            edition: edition.name,
            status: 'failed',
            reason: safeErrorCode(error),
        };
    }
}

export async function runMaxMindUpdate({
    config,
    logger = null,
    fetchImpl = globalThis.fetch,
    tarImpl = tar,
    openDatabase = openMaxMind,
    now = () => new Date(),
    force = false,
    editions = MAXMIND_EDITIONS,
} = {}) {
    if (!config?.enabled) {
        return { status: 'disabled', results: [] };
    }
    if (!config.licenseKey) {
        return { status: 'not_configured', results: [] };
    }

    await mkdir(config.dbDir, { recursive: true, mode: 0o750 });
    const lock = await acquireLock(join(config.dbDir, LOCK_FILE), config.lockStaleMs, now);
    if (!lock) {
        logger?.warn({}, 'maxmind update skipped because another update is running');
        return { status: 'locked', results: [] };
    }

    try {
        const results = [];
        for (const edition of editions) {
            results.push(await updateEdition({
                edition,
                config,
                logger,
                fetchImpl,
                tarImpl,
                openDatabase,
                now,
                force,
            }));
        }

        const failed = results.some((result) => result.status === 'failed');
        return {
            status: failed ? 'partial_failure' : 'ok',
            results,
        };
    } finally {
        await lock.release();
    }
}
