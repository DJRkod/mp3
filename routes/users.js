var User = require('../models/user');
var Task = require('../models/task');
var h = require('./helpers');

// Checks a user body. Returns { name, email, pendingTasks } or throws 400.
function validateUserBody(body) {
    if (!h.isPlainObject(body)) throw new h.HttpError(400, 'Request body must be a JSON object');
    if (!h.isNonEmptyString(body.name)) throw new h.HttpError(400, 'A user needs a name');
    if (!h.isNonEmptyString(body.email)) throw new h.HttpError(400, 'A user needs an email');
    var pendingTasks = body.pendingTasks === undefined || body.pendingTasks === null ? [] : body.pendingTasks;
    if (!Array.isArray(pendingTasks)) throw new h.HttpError(400, 'pendingTasks must be a list of task ids');
    pendingTasks.forEach(function (id) {
        if (!h.isValidId(id)) throw new h.HttpError(400, 'pendingTasks contains an invalid task id');
    });
    // Duplicates in the list are harmless; keep the first occurrence of each.
    pendingTasks = pendingTasks.filter(function (id, i) { return pendingTasks.indexOf(id) === i; });
    return { name: body.name, email: body.email, pendingTasks: pendingTasks };
}

async function ensureEmailFree(email, ownId) {
    var filter = { email: email };
    if (ownId) filter._id = { $ne: ownId };
    if (await User.exists(filter)) throw new h.HttpError(400, 'A user with this email already exists');
}

// Loads the tasks named in pendingTasks; 404 if one is missing, 400 if one is completed.
async function loadPendingTasks(ids) {
    if (ids.length === 0) return [];
    var tasks = await Task.find({ _id: { $in: ids } });
    if (tasks.length !== ids.length) throw new h.HttpError(404, 'A task in pendingTasks does not exist');
    tasks.forEach(function (task) {
        if (task.completed) throw new h.HttpError(400, 'A completed task cannot be in pendingTasks');
    });
    return tasks;
}

// Assigns the given tasks to the user, moving them away from other users.
async function assignTasks(tasks, user) {
    var ids = tasks.map(function (t) { return String(t._id); });
    if (ids.length === 0) return;
    await User.updateMany(
        { _id: { $ne: user._id }, pendingTasks: { $in: ids } },
        { $pull: { pendingTasks: { $in: ids } } }
    );
    await Task.updateMany(
        { _id: { $in: ids } },
        { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
    );
}

async function unassignTasks(ids) {
    if (ids.length === 0) return;
    await Task.updateMany(
        { _id: { $in: ids } },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
    );
}

async function findUserOr404(id) {
    if (!h.isValidId(id)) throw new h.HttpError(404, 'User not found');
    var user = await User.findById(id);
    if (!user) throw new h.HttpError(404, 'User not found');
    return user;
}

module.exports = function (router) {
    router.route('/users')
        .get(h.wrap(async function (req, res) {
            var params = h.parseListQuery(req.query, { defaultLimit: undefined });
            var data = await h.runListQuery(User, params);
            h.respond(res, 200, 'OK', data);
        }))
        .post(h.wrap(async function (req, res) {
            var fields = validateUserBody(req.body);
            await ensureEmailFree(fields.email);
            var tasks = await loadPendingTasks(fields.pendingTasks);
            var user = await User.create(fields);
            await assignTasks(tasks, user);
            h.respond(res, 201, 'User created', user);
        }));

    router.route('/users/:id')
        .get(h.wrap(async function (req, res) {
            if (!h.isValidId(req.params.id)) throw new h.HttpError(404, 'User not found');
            var select = h.parseSelect(req.query);
            var query = User.findById(req.params.id);
            if (select) query = query.select(select);
            var user = await query.exec();
            if (!user) throw new h.HttpError(404, 'User not found');
            h.respond(res, 200, 'OK', user);
        }))
        .put(h.wrap(async function (req, res) {
            var user = await findUserOr404(req.params.id);
            var fields = validateUserBody(req.body);
            await ensureEmailFree(fields.email, user._id);
            var newTasks = await loadPendingTasks(fields.pendingTasks);

            var oldIds = user.pendingTasks.slice();
            var removed = oldIds.filter(function (id) { return fields.pendingTasks.indexOf(id) < 0; });
            var added = newTasks.filter(function (t) { return oldIds.indexOf(String(t._id)) < 0; });

            user.name = fields.name;
            user.email = fields.email;
            user.pendingTasks = fields.pendingTasks;
            await user.save();

            await unassignTasks(removed);
            await assignTasks(added, user);
            // Tasks that stay with this user (completed ones too) follow a name change.
            await Task.updateMany(
                { assignedUser: String(user._id) },
                { $set: { assignedUserName: user.name } }
            );
            h.respond(res, 200, 'User updated', user);
        }))
        .delete(h.wrap(async function (req, res) {
            var user = await findUserOr404(req.params.id);
            await Task.updateMany(
                { assignedUser: String(user._id) },
                { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
            );
            await user.deleteOne();
            h.respond(res, 200, 'User deleted', user);
        }));

    return router;
};
