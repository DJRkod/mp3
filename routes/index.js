/*
 * Connect all of your endpoints together here.
 */
var express = require('express');
var h = require('./helpers');

module.exports = function (app) {
    app.use('/api', require('./home.js')(express.Router()));
    app.use('/api', require('./users.js')(express.Router()));
    app.use('/api', require('./tasks.js')(express.Router()));

    // Anything else under the API is an unknown endpoint.
    app.use('/api', function (req, res) {
        h.respond(res, 404, 'Endpoint not found');
    });

    // Every error becomes the JSON envelope; nothing from Mongoose reaches the client.
    app.use(function (err, req, res, next) {
        if (err instanceof h.HttpError) return h.respond(res, err.status, err.message);
        if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
            return h.respond(res, 400, 'Request body is not valid JSON');
        }
        if (h.isBadQueryError(err)) return h.respond(res, 400, 'Invalid query or field value');
        console.error(err);
        h.respond(res, 500, 'Something went wrong on the server');
    });
};
