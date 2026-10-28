var mongoose = require('mongoose');

var UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true },
    pendingTasks: { type: [String], default: [] },
    dateCreated: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('User', UserSchema);
