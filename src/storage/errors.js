export class StorageNotReadyError extends Error {
    constructor(message = 'Redis is not ready') {
        super(message);
        this.name = 'StorageNotReadyError';
        this.code = 'STORAGE_NOT_READY';
    }
}

export class InvalidQueryError extends Error {
    constructor(message = 'Invalid query') {
        super(message);
        this.name = 'InvalidQueryError';
        this.code = 'INVALID_QUERY';
    }
}
