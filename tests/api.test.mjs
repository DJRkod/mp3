// End-to-end tests for the task API. Starts server.js on a spare port against a
// separate database ("mp3_test" on the same cluster), then drives it over HTTP.
//
// Run with:  npm test
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const PORT = process.env.TEST_PORT || 3999;
const BASE = `http://localhost:${PORT}/api`;
const TEST_URI = process.env.MONGODB_URI.replace(/\/[^/?]*(\?|$)/, '/mp3_test$1');
const MISSING_ID = '000000000000000000000000';

let server;

// Atlas database users may not drop databases, so empty the collections instead.
async function clearDatabase() {
    const db = mongoose.connection.db;
    await Promise.all([db.collection('users').deleteMany({}), db.collection('tasks').deleteMany({})]);
}

async function api(method, url, body) {
    const res = await fetch(BASE + url, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    if (res.status === 204) {
        assert.equal(await res.text(), '', `204 on ${method} ${url} must have an empty body`);
        return { status: 204 };
    }
    const json = await res.json();
    assert.ok('message' in json && 'data' in json, `envelope missing on ${method} ${url}: ${JSON.stringify(json)}`);
    assert.equal(typeof json.message, 'string');
    return { status: res.status, ...json };
}

const get = (url) => api('GET', url);
const post = (url, body) => api('POST', url, body);
const put = (url, body) => api('PUT', url, body);
const del = (url) => api('DELETE', url);

let counter = 0;
async function makeUser(overrides = {}) {
    counter += 1;
    const res = await post('/users', { name: `User ${counter}`, email: `user${counter}@example.com`, ...overrides });
    assert.equal(res.status, 201, JSON.stringify(res));
    return res.data;
}
async function makeTask(overrides = {}) {
    counter += 1;
    const res = await post('/tasks', { name: `Task ${counter}`, deadline: '2026-12-01T00:00:00.000Z', ...overrides });
    assert.equal(res.status, 201, JSON.stringify(res));
    return res.data;
}
const user = (id) => get(`/users/${id}`).then((r) => r.data);
const task = (id) => get(`/tasks/${id}`).then((r) => r.data);

before(async () => {
    await mongoose.connect(TEST_URI);
    await clearDatabase();
    server = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: { ...process.env, PORT: String(PORT), MONGODB_URI: TEST_URI },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let i = 0; i < 100; i++) {
        try {
            await fetch(`http://localhost:${PORT}/`);
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    throw new Error('server did not start');
});

after(async () => {
    server?.kill();
    await clearDatabase();
    await mongoose.disconnect();
});

beforeEach(async () => {
    await clearDatabase();
});

// ---------- users: create & validate ----------

test('POST /users creates a user with defaults and 201', async () => {
    const res = await post('/users', { name: 'Ann', email: 'ann@example.com' });
    assert.equal(res.status, 201);
    assert.equal(res.data.name, 'Ann');
    assert.equal(res.data.email, 'ann@example.com');
    assert.deepEqual(res.data.pendingTasks, []);
    assert.ok(res.data._id);
    assert.ok(!isNaN(Date.parse(res.data.dateCreated)));
});

test('POST /users ignores a client-supplied dateCreated', async () => {
    const res = await post('/users', { name: 'Ann', email: 'a@example.com', dateCreated: '2000-01-01T00:00:00.000Z' });
    assert.notEqual(res.data.dateCreated, '2000-01-01T00:00:00.000Z');
});

test('POST /users without name or email, or with wrong types, is 400', async () => {
    assert.equal((await post('/users', { email: 'x@example.com' })).status, 400);
    assert.equal((await post('/users', { name: 'X' })).status, 400);
    assert.equal((await post('/users', { name: '', email: 'x@example.com' })).status, 400);
    assert.equal((await post('/users', { name: 42, email: 'x@example.com' })).status, 400);
    assert.equal((await post('/users', { name: 'X', email: ['x@example.com'] })).status, 400);
    assert.equal((await post('/users', { name: 'X', email: 'x@example.com', pendingTasks: 'nope' })).status, 400);
    assert.equal((await post('/users', { name: 'X', email: 'x@example.com', pendingTasks: ['bad-id'] })).status, 400);
    assert.equal((await get('/users')).data.length, 0, 'nothing was written');
});

test('POST /users with a duplicate email is 400', async () => {
    await makeUser({ email: 'dup@example.com' });
    const res = await post('/users', { name: 'Other', email: 'dup@example.com' });
    assert.equal(res.status, 400);
});

test('POST /users with a malformed JSON body is 400 with the envelope', async () => {
    const res = await post('/users', '{"name": ');
    assert.equal(res.status, 400);
});

test('POST /users with pendingTasks: missing task 404, completed task 400, valid tasks assigned', async () => {
    const t1 = await makeTask();
    const done = await makeTask({ completed: true });
    assert.equal((await post('/users', { name: 'A', email: 'a@example.com', pendingTasks: [MISSING_ID] })).status, 404);
    assert.equal((await post('/users', { name: 'A', email: 'a@example.com', pendingTasks: [done._id] })).status, 400);
    assert.equal((await get('/users')).data.length, 0, 'failed requests changed nothing');

    const u = await makeUser({ pendingTasks: [t1._id] });
    assert.deepEqual(u.pendingTasks, [t1._id]);
    const t = await task(t1._id);
    assert.equal(t.assignedUser, u._id);
    assert.equal(t.assignedUserName, u.name);
});

// ---------- tasks: create & validate ----------

test('POST /tasks creates a task with defaults and 201', async () => {
    const res = await post('/tasks', { name: 'Write', deadline: '2026-12-01T00:00:00.000Z' });
    assert.equal(res.status, 201);
    assert.equal(res.data.description, '');
    assert.equal(res.data.completed, false);
    assert.equal(res.data.assignedUser, '');
    assert.equal(res.data.assignedUserName, 'unassigned');
    assert.equal(res.data.deadline, '2026-12-01T00:00:00.000Z');
    assert.ok(res.data.dateCreated);
});

test('POST /tasks accepts a deadline given as a timestamp number', async () => {
    const res = await post('/tasks', { name: 'Write', deadline: 1764547200000 });
    assert.equal(res.status, 201);
    assert.equal(res.data.deadline, '2025-12-01T00:00:00.000Z');
});

test('POST /tasks without name or deadline, or with wrong types, is 400', async () => {
    assert.equal((await post('/tasks', { deadline: '2026-12-01' })).status, 400);
    assert.equal((await post('/tasks', { name: 'X' })).status, 400);
    assert.equal((await post('/tasks', { name: 'X', deadline: 'not a date' })).status, 400);
    assert.equal((await post('/tasks', { name: 'X', deadline: '2026-12-01', completed: 'yes' })).status, 400);
    assert.equal((await post('/tasks', { name: 'X', deadline: '2026-12-01', description: 5 })).status, 400);
    assert.equal((await post('/tasks', { name: 'X', deadline: '2026-12-01', assignedUser: 'bad' })).status, 400);
    assert.equal((await post('/tasks', { name: 'X', deadline: '2026-12-01', assignedUser: 12 })).status, 400);
    assert.equal((await get('/tasks')).data.length, 0);
});

test('POST /tasks assignment: missing user 404, wrong name 400, name filled in, pendingTasks updated', async () => {
    const u = await makeUser({ name: 'Bea' });
    assert.equal((await post('/tasks', { name: 'X', deadline: '2026-12-01', assignedUser: MISSING_ID })).status, 404);
    assert.equal((await post('/tasks', { name: 'X', deadline: '2026-12-01', assignedUser: u._id, assignedUserName: 'Wrong' })).status, 400);
    assert.deepEqual((await user(u._id)).pendingTasks, []);

    const t = await makeTask({ assignedUser: u._id });
    assert.equal(t.assignedUserName, 'Bea');
    assert.deepEqual((await user(u._id)).pendingTasks, [t._id]);

    const t2 = await makeTask({ assignedUser: u._id, assignedUserName: 'Bea' });
    assert.deepEqual((await user(u._id)).pendingTasks.sort(), [t._id, t2._id].sort());
});

test('POST /tasks that is completed and assigned is not added to pendingTasks', async () => {
    const u = await makeUser();
    const t = await makeTask({ assignedUser: u._id, completed: true });
    assert.equal(t.assignedUser, u._id);
    assert.deepEqual((await user(u._id)).pendingTasks, []);
});

// ---------- single resources ----------

test('GET /users/:id and /tasks/:id return the resource, 404 for unknown and malformed ids', async () => {
    const u = await makeUser();
    const t = await makeTask();
    assert.equal((await get(`/users/${u._id}`)).data.email, u.email);
    assert.equal((await get(`/tasks/${t._id}`)).data.name, t.name);
    assert.equal((await get(`/users/${MISSING_ID}`)).status, 404);
    assert.equal((await get(`/tasks/${MISSING_ID}`)).status, 404);
    assert.equal((await get('/users/not-an-id')).status, 404);
    assert.equal((await get('/tasks/not-an-id')).status, 404);
});

test('select works on single resources and other parameters are ignored there', async () => {
    const u = await makeUser({ name: 'Cy' });
    const t = await makeTask();
    let res = await get(`/users/${u._id}?select={"name":1}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.data).sort(), ['_id', 'name']);
    res = await get(`/tasks/${t._id}?select={"_id":0,"dateCreated":0}`);
    assert.equal(res.status, 200);
    assert.ok(!('_id' in res.data) && !('dateCreated' in res.data) && 'name' in res.data);
    res = await get(`/users/${u._id}?where={"name":"nobody"}&limit=0`);
    assert.equal(res.status, 200);
    assert.equal(res.data.name, 'Cy');
    assert.equal((await get(`/users/${u._id}?select=notjson`)).status, 400);
});

// ---------- list queries ----------

test('GET /tasks supports where, sort, select, skip, limit and count together', async () => {
    const u = await makeUser();
    for (let i = 0; i < 5; i++) {
        await makeTask({ name: `T${i}`, completed: i % 2 === 0, assignedUser: i < 3 ? u._id : '' });
    }
    let res = await get('/tasks?where={"completed":true}');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.map((t) => t.name).sort(), ['T0', 'T2', 'T4']);

    res = await get('/tasks?sort={"name":-1}');
    assert.deepEqual(res.data.map((t) => t.name), ['T4', 'T3', 'T2', 'T1', 'T0']);

    res = await get('/tasks?sort={"name":1}&skip=1&limit=2');
    assert.deepEqual(res.data.map((t) => t.name), ['T1', 'T2']);

    res = await get('/tasks?select={"name":1}');
    assert.deepEqual(Object.keys(res.data[0]).sort(), ['_id', 'name']);

    res = await get('/tasks?select={"_id":0}');
    assert.ok(!('_id' in res.data[0]));

    res = await get('/tasks?count=true');
    assert.equal(res.data, 5);
    res = await get(`/tasks?where={"assignedUser":"${u._id}"}&count=true`);
    assert.equal(res.data, 3);

    res = await get(`/tasks?where={"completed":false}&sort={"name":1}&select={"name":1}&skip=0&limit=1`);
    assert.deepEqual(res.data, [{ _id: res.data[0]._id, name: 'T1' }]);

    const ids = res.data.map((t) => t._id);
    res = await get(`/tasks?where={"_id":{"$in":${JSON.stringify(ids)}}}`);
    assert.equal(res.data.length, 1);
});

test('GET list with no match is 200 and an empty list (or 0 for count)', async () => {
    let res = await get(`/users?where={"_id":"${MISSING_ID}"}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, []);
    res = await get(`/tasks?where={"name":"nobody"}&count=true`);
    assert.equal(res.status, 200);
    assert.equal(res.data, 0);
});

test('GET /tasks defaults to 100 results and GET /users is unlimited', async () => {
    const docs = [];
    for (let i = 0; i < 120; i++) {
        docs.push({ name: `Bulk ${i}`, deadline: new Date(), dateCreated: new Date() });
    }
    await mongoose.connection.db.collection('tasks').insertMany(docs);
    await mongoose.connection.db.collection('users').insertMany(
        docs.map((d, i) => ({ name: d.name, email: `b${i}@example.com`, pendingTasks: [], dateCreated: new Date() }))
    );
    assert.equal((await get('/tasks')).data.length, 100);
    assert.equal((await get('/tasks?limit=110')).data.length, 110);
    assert.equal((await get('/users')).data.length, 120);
});

test('invalid query parameters are 400', async () => {
    assert.equal((await get('/tasks?where={bad')).status, 400);
    assert.equal((await get('/tasks?where=[1]')).status, 400);
    assert.equal((await get('/tasks?sort=nope')).status, 400);
    assert.equal((await get('/tasks?limit=abc')).status, 400);
    assert.equal((await get('/tasks?skip=-1')).status, 400);
    assert.equal((await get('/users?select={"name":1,"email":0}')).status, 400, 'mixed projection');
    assert.equal((await get('/users?where={"_id":"not-an-object-id"}')).status, 400, 'uncastable value');
});

// ---------- PUT /users/:id ----------

test('PUT /users/:id replaces the user, keeps dateCreated, 404 for unknown ids', async () => {
    const u = await makeUser({ name: 'Old', email: 'old@example.com' });
    const res = await put(`/users/${u._id}`, { name: 'New', email: 'new@example.com', dateCreated: '2000-01-01T00:00:00.000Z' });
    assert.equal(res.status, 200);
    assert.equal(res.data.name, 'New');
    assert.equal(res.data.email, 'new@example.com');
    assert.deepEqual(res.data.pendingTasks, []);
    assert.equal(res.data.dateCreated, u.dateCreated);
    assert.equal((await put(`/users/${MISSING_ID}`, { name: 'N', email: 'n@example.com' })).status, 404);
    assert.equal((await put('/users/garbage', { name: 'N', email: 'n@example.com' })).status, 404);
});

test('PUT /users/:id validation order: 404 id, 400 fields, 400 email, 404 tasks, 400 completed', async () => {
    const u = await makeUser({ email: 'me@example.com' });
    const other = await makeUser({ email: 'taken@example.com' });
    const done = await makeTask({ completed: true });
    assert.equal((await put(`/users/${MISSING_ID}`, {})).status, 404);
    assert.equal((await put(`/users/${u._id}`, { email: 'me@example.com' })).status, 400);
    assert.equal((await put(`/users/${u._id}`, { name: 'Me', email: 'me@example.com', pendingTasks: ['x'] })).status, 400);
    assert.equal((await put(`/users/${u._id}`, { name: 'Me', email: 'taken@example.com' })).status, 400);
    assert.equal((await put(`/users/${u._id}`, { name: 'Me', email: 'me@example.com', pendingTasks: [MISSING_ID] })).status, 404);
    assert.equal((await put(`/users/${u._id}`, { name: 'Me', email: 'me@example.com', pendingTasks: [done._id] })).status, 400);
    assert.equal((await put(`/users/${u._id}`, { name: 'Me', email: 'me@example.com' })).status, 200, 'keeping own email is fine');
    assert.equal((await user(other._id)).email, 'taken@example.com');
});

test('PUT /users/:id pendingTasks diff: removed tasks unassigned, added tasks assigned, moved tasks leave the other user', async () => {
    const a = await makeUser({ name: 'A' });
    const b = await makeUser({ name: 'B' });
    const t1 = await makeTask({ assignedUser: a._id });
    const t2 = await makeTask();
    const t3 = await makeTask({ assignedUser: b._id });
    assert.deepEqual((await user(a._id)).pendingTasks, [t1._id]);
    assert.deepEqual((await user(b._id)).pendingTasks, [t3._id]);

    const res = await put(`/users/${a._id}`, { name: 'A', email: a.email, pendingTasks: [t2._id, t3._id] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.pendingTasks, [t2._id, t3._id]);

    const [r1, r2, r3] = await Promise.all([task(t1._id), task(t2._id), task(t3._id)]);
    assert.equal(r1.assignedUser, '');
    assert.equal(r1.assignedUserName, 'unassigned');
    assert.equal(r2.assignedUser, a._id);
    assert.equal(r2.assignedUserName, 'A');
    assert.equal(r3.assignedUser, a._id);
    assert.equal(r3.assignedUserName, 'A');
    assert.deepEqual((await user(b._id)).pendingTasks, []);
});

test('PUT /users/:id with a changed name renames the user on all their tasks, including completed ones', async () => {
    const u = await makeUser({ name: 'Before' });
    const pending = await makeTask({ assignedUser: u._id });
    const done = await makeTask({ assignedUser: u._id, completed: true });
    const res = await put(`/users/${u._id}`, { name: 'After', email: u.email, pendingTasks: [pending._id] });
    assert.equal(res.status, 200);
    assert.equal((await task(pending._id)).assignedUserName, 'After');
    const d = await task(done._id);
    assert.equal(d.assignedUserName, 'After');
    assert.equal(d.assignedUser, u._id, 'completed task stays assigned');
});

test('PUT /users/:id with no pendingTasks empties the list and unassigns the tasks', async () => {
    const u = await makeUser();
    const t = await makeTask({ assignedUser: u._id });
    const res = await put(`/users/${u._id}`, { name: u.name, email: u.email });
    assert.deepEqual(res.data.pendingTasks, []);
    assert.equal((await task(t._id)).assignedUser, '');
});

// ---------- PUT /tasks/:id ----------

test('PUT /tasks/:id replaces the task, applies defaults, keeps dateCreated, 404 for unknown ids', async () => {
    const t = await makeTask({ description: 'desc', completed: true });
    const res = await put(`/tasks/${t._id}`, { name: 'Renamed', deadline: '2027-01-01T00:00:00.000Z', dateCreated: '2000-01-01T00:00:00.000Z' });
    assert.equal(res.status, 200);
    assert.equal(res.data.name, 'Renamed');
    assert.equal(res.data.description, '');
    assert.equal(res.data.completed, false);
    assert.equal(res.data.assignedUser, '');
    assert.equal(res.data.assignedUserName, 'unassigned');
    assert.equal(res.data.deadline, '2027-01-01T00:00:00.000Z');
    assert.equal(res.data.dateCreated, t.dateCreated);
    assert.equal((await put(`/tasks/${MISSING_ID}`, { name: 'N', deadline: '2027-01-01' })).status, 404);
    assert.equal((await put('/tasks/garbage', { name: 'N', deadline: '2027-01-01' })).status, 404);
});

test('PUT /tasks/:id validation: 400 missing fields, 400 malformed assignedUser, 404 unknown user, 400 name mismatch', async () => {
    const u = await makeUser({ name: 'Real' });
    const t = await makeTask();
    assert.equal((await put(`/tasks/${t._id}`, { deadline: '2027-01-01' })).status, 400);
    assert.equal((await put(`/tasks/${t._id}`, { name: 'N' })).status, 400);
    assert.equal((await put(`/tasks/${t._id}`, { name: 'N', deadline: '2027-01-01', assignedUser: 'nope' })).status, 400);
    assert.equal((await put(`/tasks/${t._id}`, { name: 'N', deadline: '2027-01-01', assignedUser: MISSING_ID })).status, 404);
    assert.equal((await put(`/tasks/${t._id}`, { name: 'N', deadline: '2027-01-01', assignedUser: u._id, assignedUserName: 'Fake' })).status, 400);
    assert.equal((await task(t._id)).name, t.name, 'nothing changed');
    assert.deepEqual((await user(u._id)).pendingTasks, []);
});

test('PUT /tasks/:id assigning adds to pendingTasks; reassigning moves it; unassigning removes it', async () => {
    const a = await makeUser({ name: 'A' });
    const b = await makeUser({ name: 'B' });
    const t = await makeTask();
    const body = { name: t.name, deadline: t.deadline };

    let res = await put(`/tasks/${t._id}`, { ...body, assignedUser: a._id });
    assert.equal(res.data.assignedUserName, 'A');
    assert.deepEqual((await user(a._id)).pendingTasks, [t._id]);

    res = await put(`/tasks/${t._id}`, { ...body, assignedUser: b._id });
    assert.equal(res.data.assignedUserName, 'B');
    assert.deepEqual((await user(a._id)).pendingTasks, []);
    assert.deepEqual((await user(b._id)).pendingTasks, [t._id]);

    res = await put(`/tasks/${t._id}`, { ...body, assignedUser: '' });
    assert.equal(res.data.assignedUserName, 'unassigned');
    assert.deepEqual((await user(b._id)).pendingTasks, []);
});

test('PUT /tasks/:id completing removes it from pendingTasks but keeps it assigned; uncompleting re-adds it', async () => {
    const u = await makeUser();
    const t = await makeTask({ assignedUser: u._id });
    const body = { name: t.name, deadline: t.deadline, assignedUser: u._id };

    let res = await put(`/tasks/${t._id}`, { ...body, completed: true });
    assert.equal(res.status, 200);
    assert.equal(res.data.assignedUser, u._id);
    assert.deepEqual((await user(u._id)).pendingTasks, []);

    res = await put(`/tasks/${t._id}`, { ...body, completed: false });
    assert.deepEqual((await user(u._id)).pendingTasks, [t._id]);
});

test('PUT /tasks/:id can reassign a completed task without touching pendingTasks', async () => {
    const a = await makeUser({ name: 'A' });
    const b = await makeUser({ name: 'B' });
    const t = await makeTask({ assignedUser: a._id, completed: true });
    const res = await put(`/tasks/${t._id}`, { name: t.name, deadline: t.deadline, completed: true, assignedUser: b._id });
    assert.equal(res.status, 200);
    assert.equal(res.data.assignedUserName, 'B');
    assert.deepEqual((await user(a._id)).pendingTasks, []);
    assert.deepEqual((await user(b._id)).pendingTasks, []);
});

// ---------- DELETE ----------

test('DELETE /tasks/:id is 204 with no body, takes the task out of pendingTasks; 404 afterwards', async () => {
    const u = await makeUser();
    const t = await makeTask({ assignedUser: u._id });
    const res = await del(`/tasks/${t._id}`);
    assert.equal(res.status, 204);
    assert.equal((await get(`/tasks/${t._id}`)).status, 404);
    assert.deepEqual((await user(u._id)).pendingTasks, []);
    assert.equal((await del(`/tasks/${t._id}`)).status, 404);
    assert.equal((await del('/tasks/garbage')).status, 404);
});

test('DELETE /users/:id is 204 with no body and unassigns all their tasks, completed ones too', async () => {
    const u = await makeUser();
    const pending = await makeTask({ assignedUser: u._id });
    const done = await makeTask({ assignedUser: u._id, completed: true });
    const res = await del(`/users/${u._id}`);
    assert.equal(res.status, 204);
    assert.equal((await get(`/users/${u._id}`)).status, 404);
    for (const id of [pending._id, done._id]) {
        const t = await task(id);
        assert.equal(t.assignedUser, '');
        assert.equal(t.assignedUserName, 'unassigned');
    }
    assert.equal((await del(`/users/${MISSING_ID}`)).status, 404);
});

test('unknown API routes are 404 with the envelope', async () => {
    assert.equal((await get('/nothing')).status, 404);
});
