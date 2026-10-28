var User = require('../models/user');
var Task = require('../models/task');
var h = require('./helpers');

var DEFAULT_LIMIT = 100;

function parseDeadline(value) {
    if (value instanceof Date) return value;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
}

function orDefault(value, fallback) {
    return value === undefined || value === null ? fallback : value;
}

// Checks a task body. Returns the task fields (assignee's name not yet
// resolved) or throws 400.
function validateTaskBody(body) {
    if (!h.isPlainObject(body)) throw new h.HttpError(400, 'Request body must be a JSON object');
    if (!h.isNonEmptyString(body.name)) throw new h.HttpError(400, 'A task needs a name');
    if (body.deadline === undefined || body.deadline === null) throw new h.HttpError(400, 'A task needs a deadline');
    var deadline = parseDeadline(body.deadline);
    if (!deadline) throw new h.HttpError(400, 'deadline must be a valid date');

    var description = orDefault(body.description, '');
    if (typeof description !== 'string') throw new h.HttpError(400, 'description must be a string');

    var completed = orDefault(body.completed, false);
    if (typeof completed !== 'boolean') throw new h.HttpError(400, 'completed must be true or false');

    var assignedUser = orDefault(body.assignedUser, '');
    if (typeof assignedUser !== 'string') throw new h.HttpError(400, 'assignedUser must be a user id');
    if (assignedUser !== '' && !h.isValidId(assignedUser)) throw new h.HttpError(400, 'assignedUser is not a valid user id');

    var assignedUserName = orDefault(body.assignedUserName, undefined);
    if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
        throw new h.HttpError(400, 'assignedUserName must be a string');
    }

    return {
        name: body.name,
        description: description,
        deadline: deadline,
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

// Resolves the assignee: 404 if the user does not exist, 400 if the supplied
// name does not match. Fills in assignedUserName.
async function resolveAssignee(fields) {
    if (fields.assignedUser === '') {
        fields.assignedUserName = 'unassigned';
        return;
    }
    var user = await User.findById(fields.assignedUser);
    if (!user) throw new h.HttpError(404, 'The assigned user does not exist');
    if (fields.assignedUserName !== undefined && fields.assignedUserName !== user.name) {
        throw new h.HttpError(400, 'assignedUserName does not match the assigned user');
    }
    fields.assignedUserName = user.name;
}

// Puts the task into (or takes it out of) its assignee's pendingTasks, and
// removes it from the previous assignee's list when the task moved.
async function syncAssignee(task, previousUserId) {
    var id = String(task._id);
    if (previousUserId && previousUserId !== task.assignedUser) {
        await User.updateOne({ _id: previousUserId }, { $pull: { pendingTasks: id } });
    }
    if (task.assignedUser) {
        if (task.completed) {
            await User.updateOne({ _id: task.assignedUser }, { $pull: { pendingTasks: id } });
        } else {
            await User.updateOne({ _id: task.assignedUser }, { $addToSet: { pendingTasks: id } });
        }
    }
}

async function findTaskOr404(id) {
    if (!h.isValidId(id)) throw new h.HttpError(404, 'Task not found');
    var task = await Task.findById(id);
    if (!task) throw new h.HttpError(404, 'Task not found');
    return task;
}

module.exports = function (router) {
    router.route('/tasks')
        .get(h.wrap(async function (req, res) {
            var params = h.parseListQuery(req.query, { defaultLimit: DEFAULT_LIMIT });
            var data = await h.runListQuery(Task, params);
            h.respond(res, 200, 'OK', data);
        }))
        .post(h.wrap(async function (req, res) {
            var fields = validateTaskBody(req.body);
            await resolveAssignee(fields);
            var task = await Task.create(fields);
            await syncAssignee(task, null);
            h.respond(res, 201, 'Task created', task);
        }));

    router.route('/tasks/:id')
        .get(h.wrap(async function (req, res) {
            if (!h.isValidId(req.params.id)) throw new h.HttpError(404, 'Task not found');
            var select = h.parseSelect(req.query);
            var query = Task.findById(req.params.id);
            if (select) query = query.select(select);
            var task = await query.exec();
            if (!task) throw new h.HttpError(404, 'Task not found');
            h.respond(res, 200, 'OK', task);
        }))
        .put(h.wrap(async function (req, res) {
            var task = await findTaskOr404(req.params.id);
            var fields = validateTaskBody(req.body);
            await resolveAssignee(fields);

            var previousUserId = task.assignedUser;
            task.name = fields.name;
            task.description = fields.description;
            task.deadline = fields.deadline;
            task.completed = fields.completed;
            task.assignedUser = fields.assignedUser;
            task.assignedUserName = fields.assignedUserName;
            await task.save();
            await syncAssignee(task, previousUserId);
            h.respond(res, 200, 'Task updated', task);
        }))
        .delete(h.wrap(async function (req, res) {
            var task = await findTaskOr404(req.params.id);
            if (task.assignedUser) {
                await User.updateOne({ _id: task.assignedUser }, { $pull: { pendingTasks: String(task._id) } });
            }
            await task.deleteOne();
            h.respond(res, 200, 'Task deleted', task);
        }));

    return router;
};
