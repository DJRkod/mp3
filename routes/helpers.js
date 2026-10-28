// Shared pieces for the users and tasks routes: the response envelope, an
// error type that carries an HTTP status, id checks, and query-string parsing.

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function respond(res, status, message, data) {
    res.status(status).json({ message: message, data: data === undefined ? null : data });
}

var OBJECT_ID = /^[0-9a-fA-F]{24}$/;
function isValidId(value) {
    return typeof value === 'string' && OBJECT_ID.test(value);
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function first(query, name) {
    return Array.isArray(query[name]) ? query[name][0] : query[name];
}

function parseJsonParam(raw, name) {
    if (raw === undefined) return undefined;
    var value;
    try {
        value = JSON.parse(raw);
    } catch (e) {
        throw new HttpError(400, 'Query parameter "' + name + '" is not valid JSON');
    }
    if (!isPlainObject(value)) {
        throw new HttpError(400, 'Query parameter "' + name + '" must be a JSON object');
    }
    return value;
}

function parseIntParam(raw, name) {
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(String(raw).trim())) {
        throw new HttpError(400, 'Query parameter "' + name + '" must be a non-negative integer');
    }
    return parseInt(raw, 10);
}

function parseCount(raw) {
    if (raw === undefined) return false;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0' || raw === '') return false;
    throw new HttpError(400, 'Query parameter "count" must be true or false');
}

// Parses where/sort/select/skip/limit/count for a collection endpoint. Only
// the first value of a repeated parameter is used.
function parseListQuery(query, options) {
    var limit = parseIntParam(first(query, 'limit'), 'limit');
    return {
        where: parseJsonParam(first(query, 'where'), 'where') || {},
        sort: parseJsonParam(first(query, 'sort'), 'sort'),
        select: parseJsonParam(first(query, 'select'), 'select'),
        skip: parseIntParam(first(query, 'skip'), 'skip'),
        limit: limit === undefined ? options.defaultLimit : limit,
        count: parseCount(first(query, 'count'))
    };
}

function parseSelect(query) {
    return parseJsonParam(first(query, 'select'), 'select');
}

// Runs a list query against a model and returns the documents or the count.
async function runListQuery(Model, params) {
    if (params.count) {
        return Model.countDocuments(params.where);
    }
    var query = Model.find(params.where);
    if (params.sort) query = query.sort(params.sort);
    if (params.select) query = query.select(params.select);
    if (params.skip) query = query.skip(params.skip);
    if (params.limit !== undefined) query = query.limit(params.limit);
    return query.exec();
}

// Errors MongoDB/Mongoose raise for malformed filters, sorts or projections
// are the client's fault, not the server's.
var BAD_QUERY_CODES = [2, 15975, 15976, 31253, 31254, 51175, 4772600];
function isBadQueryError(err) {
    if (!err) return false;
    if (err.name === 'CastError' || err.name === 'ValidationError') return true;
    return err.name === 'MongoServerError' && BAD_QUERY_CODES.indexOf(err.code) >= 0;
}

// Wraps an async route so rejections reach the error middleware.
function wrap(handler) {
    return function (req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

module.exports = {
    HttpError: HttpError,
    respond: respond,
    isValidId: isValidId,
    isNonEmptyString: isNonEmptyString,
    isPlainObject: isPlainObject,
    parseListQuery: parseListQuery,
    parseSelect: parseSelect,
    runListQuery: runListQuery,
    isBadQueryError: isBadQueryError,
    wrap: wrap
};
